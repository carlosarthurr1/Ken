use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod codex;
mod llm;
mod local;
mod models;
mod ollama;
mod search;

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime,
};

static LAST_SHOW_MS: AtomicU64 = AtomicU64::new(0);
static HOLD_FOCUS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
const FOCUS_GRACE_MS: u64 = 600;
const FILE_PICKER_FOCUS_HOLD_MS: u64 = 120_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_path() -> std::path::PathBuf {
    std::path::PathBuf::from("/tmp/ken.log")
}

fn log_line(msg: &str) {
    eprintln!("{msg}");
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "{} {}", now_ms(), msg);
    }
}

macro_rules! klog {
  ($($arg:tt)*) => { log_line(&format!($($arg)*)) };
}

const DOUBLE_ALT_WINDOW: Duration = Duration::from_millis(800);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ModifierKey {
    Alt,
    Cmd,
    Ctrl,
    Shift,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum HotkeySpec {
    DoubleTap {
        key: ModifierKey,
    },
    Combo {
        modifiers: Vec<ModifierKey>,
        /// JS `KeyboardEvent.code`, e.g. "Space", "KeyK", "F1".
        code: String,
    },
}

impl Default for HotkeySpec {
    fn default() -> Self {
        // Mirrors the historical default users are already trained on.
        HotkeySpec::DoubleTap {
            key: ModifierKey::Alt,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Hotkeys {
    open: HotkeySpec,
    /// `None` = proofread is disabled. We want this off-by-default so
    /// existing users don't accidentally trigger it.
    proofread: Option<HotkeySpec>,
}

#[derive(Default, Clone)]
struct HotkeyState(Arc<RwLock<Hotkeys>>);

/// Tag injected into events we synthesize via CGEventPost so our own tap
/// can ignore them. Without this, sending Cmd+C re-triggers our double-Cmd
/// handler. The value is arbitrary — just has to be unique.
const KEN_SYNTH_USER_DATA: i64 = 0x4B_454E_5359_4E54; // "KENSYNT"

impl ModifierKey {
    /// NSEvent modifier flag bits (also what CGEvent::get_flags returns).
    const fn flag(self) -> u64 {
        match self {
            ModifierKey::Shift => 0x0002_0000,
            ModifierKey::Ctrl => 0x0004_0000,
            ModifierKey::Alt => 0x0008_0000,
            ModifierKey::Cmd => 0x0010_0000,
        }
    }

    const fn index(self) -> usize {
        match self {
            ModifierKey::Shift => 0,
            ModifierKey::Ctrl => 1,
            ModifierKey::Alt => 2,
            ModifierKey::Cmd => 3,
        }
    }
}
const PALETTE_COLLAPSED_WIDTH: f64 = 760.0;
const PALETTE_EXPANDED_WIDTH: f64 = 800.0;
const PALETTE_COLLAPSED_HEIGHT: f64 = 76.0;
const PALETTE_EXPANDED_HEIGHT: f64 = 430.0;
const TRAY_ICON_SIZE: u32 = 32;
#[cfg(target_os = "macos")]
const TRAY_ICON_RGBA: &[u8] = include_bytes!("../icons/tray-template.rgba");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_RGBA: &[u8] = include_bytes!("../icons/tray-color.rgba");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveGeneratedImagesRequest {
    prompt: String,
    images: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    path: String,
    file_name: String,
}

#[tauri::command]
fn hide_palette(app: AppHandle) {
    hide_palette_window(&app);
}

#[tauri::command]
fn begin_file_picker() {
    HOLD_FOCUS_UNTIL_MS.store(
        now_ms().saturating_add(FILE_PICKER_FOCUS_HOLD_MS),
        Ordering::Relaxed,
    );
    klog!("begin_file_picker");
}

#[tauri::command]
fn finish_file_picker(app: AppHandle) {
    HOLD_FOCUS_UNTIL_MS.store(0, Ordering::Relaxed);
    show_palette(&app);
    klog!("finish_file_picker");
}

#[tauri::command]
fn save_generated_images(request: SaveGeneratedImagesRequest) -> Result<Vec<SavedImage>, String> {
    if request.images.is_empty() {
        return Ok(Vec::new());
    }

    let dir = generated_images_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create image folder {}: {error}", dir.display()))?;

    let slug = filename_slug(&request.prompt);
    let timestamp = now_ms();
    let mut saved = Vec::with_capacity(request.images.len());

    for (index, image) in request.images.iter().enumerate() {
        let bytes = decode_image_base64(image)?;
        let file_name = unique_image_name(&dir, &slug, timestamp, index + 1);
        let path = dir.join(&file_name);
        fs::write(&path, bytes)
            .map_err(|error| format!("Could not save image {}: {error}", path.display()))?;
        saved.push(SavedImage {
            path: path.to_string_lossy().into_owned(),
            file_name,
        });
    }

    Ok(saved)
}

#[tauri::command]
fn copy_image_to_downloads(path: String) -> Result<SavedImage, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("Image not found: {path}"));
    }

    // Only allow copying files KEN itself wrote, so a future stray invoke
    // can't be tricked into exfiltrating arbitrary files.
    let allowed = generated_images_dir()?;
    let canonical_source = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve image path: {error}"))?;
    let canonical_allowed = allowed
        .canonicalize()
        .map_err(|error| format!("Could not resolve image folder: {error}"))?;
    if !canonical_source.starts_with(&canonical_allowed) {
        return Err("Refusing to copy a file outside KEN's image folder.".into());
    }

    let downloads = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not locate the Downloads folder.".to_string())?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("Could not access Downloads folder: {error}"))?;

    let original_name = canonical_source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();
    let target = unique_path_in(&downloads, &original_name);

    fs::copy(&canonical_source, &target)
        .map_err(|error| format!("Could not copy to Downloads: {error}"))?;

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(original_name);

    Ok(SavedImage {
        path: target.to_string_lossy().into_owned(),
        file_name,
    })
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("File not found: {path}"));
    }
    reveal_path(&target)
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not reveal in Finder: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map_err(|error| format!("Could not reveal in Explorer: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    let parent = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map_err(|error| format!("Could not open file manager: {error}"))?;
    Ok(())
}

fn unique_path_in(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let initial = dir.join(file_name);
    if !initial.exists() {
        return initial;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (file_name.to_string(), String::new()),
    };
    for n in 1..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    initial
}

#[tauri::command]
fn set_palette_expanded(app: AppHandle, expanded: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let (width, height) = if expanded {
            (PALETTE_EXPANDED_WIDTH, PALETTE_EXPANDED_HEIGHT)
        } else {
            (PALETTE_COLLAPSED_WIDTH, PALETTE_COLLAPSED_HEIGHT)
        };

        let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
        let _ = window.set_shadow(false);
        let previous_position = window.outer_position().ok();
        let previous_size = window.outer_size().ok();
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let _ = window.set_size(LogicalSize::new(width, height));

        if let (Some(position), Some(size)) = (previous_position, previous_size) {
            let next_width = (width * scale_factor).round() as i32;
            let previous_width = size.width as i32;
            let next_x = position.x + ((previous_width - next_width) / 2);
            let _ = window.set_position(PhysicalPosition::new(next_x, position.y));
        } else {
            let _ = window.center();
        }
    }
}

#[tauri::command]
fn open_ollama_download() -> Result<(), String> {
    open_external_url("https://ollama.com/download")
}

#[tauri::command]
fn open_ollama_library() -> Result<(), String> {
    open_external_url("https://ollama.com/library")
}

/// On macOS the double-Option hotkey relies on a CGEventTap, which only
/// works when KEN has Accessibility permission. The frontend uses this to
/// flag the missing permission and surface a one-click fix.
#[tauri::command]
fn accessibility_status() -> bool {
    accessibility_granted()
}

#[tauri::command]
fn input_monitoring_status() -> bool {
    input_monitoring_granted()
}

/// Open System Settings (System Preferences) at Privacy → Accessibility so
/// the user can flip the toggle for KEN without hunting through settings.
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open Accessibility settings: {error}"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = request_input_monitoring_access();
        return std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open Input Monitoring settings: {error}"));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn accessibility_granted() -> bool {
    // AXIsProcessTrusted lives in ApplicationServices/HIServices. Calling it
    // (rather than AXIsProcessTrustedWithOptions) is the no-prompt variant —
    // the prompt would be redundant here since we render our own UI.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn input_monitoring_granted() -> bool {
    unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) == K_IOHID_ACCESS_TYPE_GRANTED }
}

#[cfg(target_os = "macos")]
fn request_input_monitoring_access() -> bool {
    unsafe { IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) }
}

#[cfg(target_os = "macos")]
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
#[cfg(target_os = "macos")]
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request_type: u32) -> u32;
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}

#[cfg(not(target_os = "macos"))]
fn accessibility_granted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn input_monitoring_granted() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn open_external_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Could not open Ollama download page: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_external_url(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("Could not open Ollama download page: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_external_url(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Could not open Ollama download page: {error}"))?;
    Ok(())
}

fn generated_images_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not locate the Pictures or home folder.".to_string())?;
    Ok(base.join("KEN").join("Generated Images"))
}

fn decode_image_base64(raw: &str) -> Result<Vec<u8>, String> {
    let payload = raw
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(raw)
        .trim();

    general_purpose::STANDARD
        .decode(payload)
        .or_else(|_| general_purpose::URL_SAFE_NO_PAD.decode(payload))
        .map_err(|error| format!("Generated image was not valid base64: {error}"))
}

fn filename_slug(prompt: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in prompt.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }

        if slug.len() >= 48 {
            break;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "image".to_string()
    } else {
        slug
    }
}

fn unique_image_name(dir: &Path, slug: &str, timestamp: u64, index: usize) -> String {
    let base = format!("{timestamp}-{slug}-{index}");
    let mut candidate = format!("{base}.png");
    let mut suffix = 2;

    while dir.join(&candidate).exists() {
        candidate = format!("{base}-{suffix}.png");
        suffix += 1;
    }

    candidate
}

fn show_palette<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        LAST_SHOW_MS.store(now_ms(), Ordering::Relaxed);
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("palette-opened", ());
        klog!("show_palette");
    }
}

fn hide_palette_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app;
    klog!("hide_palette");
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show KEN", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(tray_icon())
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("KEN")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_palette(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_palette(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn tray_icon() -> Image<'static> {
    Image::new(TRAY_ICON_RGBA, TRAY_ICON_SIZE, TRAY_ICON_SIZE)
}

/// Translate JS `KeyboardEvent.code` into the macOS Carbon virtual keycode
/// reported by CGEvent. Covers letters, digits, function keys, and the
/// common punctuation/whitespace/arrow keys — enough for any reasonable
/// hotkey. Returns `None` for unmapped codes (the user just won't be able
/// to bind them).
fn macos_keycode_for(code: &str) -> Option<i64> {
    match code {
        // Letters
        "KeyA" => Some(0),
        "KeyS" => Some(1),
        "KeyD" => Some(2),
        "KeyF" => Some(3),
        "KeyH" => Some(4),
        "KeyG" => Some(5),
        "KeyZ" => Some(6),
        "KeyX" => Some(7),
        "KeyC" => Some(8),
        "KeyV" => Some(9),
        "KeyB" => Some(11),
        "KeyQ" => Some(12),
        "KeyW" => Some(13),
        "KeyE" => Some(14),
        "KeyR" => Some(15),
        "KeyY" => Some(16),
        "KeyT" => Some(17),
        "KeyO" => Some(31),
        "KeyU" => Some(32),
        "KeyI" => Some(34),
        "KeyP" => Some(35),
        "KeyL" => Some(37),
        "KeyJ" => Some(38),
        "KeyK" => Some(40),
        "KeyN" => Some(45),
        "KeyM" => Some(46),
        // Digits (top row)
        "Digit1" => Some(18),
        "Digit2" => Some(19),
        "Digit3" => Some(20),
        "Digit4" => Some(21),
        "Digit6" => Some(22),
        "Digit5" => Some(23),
        "Digit9" => Some(25),
        "Digit7" => Some(26),
        "Digit8" => Some(28),
        "Digit0" => Some(29),
        // Whitespace / control
        "Space" => Some(49),
        "Enter" => Some(36),
        "Tab" => Some(48),
        "Escape" => Some(53),
        "Backspace" => Some(51),
        // Punctuation
        "Equal" => Some(24),
        "Minus" => Some(27),
        "BracketRight" => Some(30),
        "BracketLeft" => Some(33),
        "Quote" => Some(39),
        "Semicolon" => Some(41),
        "Backslash" => Some(42),
        "Comma" => Some(43),
        "Slash" => Some(44),
        "Period" => Some(47),
        "Backquote" => Some(50),
        // Arrows
        "ArrowLeft" => Some(123),
        "ArrowRight" => Some(124),
        "ArrowDown" => Some(125),
        "ArrowUp" => Some(126),
        // Function keys
        "F1" => Some(122),
        "F2" => Some(120),
        "F3" => Some(99),
        "F4" => Some(118),
        "F5" => Some(96),
        "F6" => Some(97),
        "F7" => Some(98),
        "F8" => Some(100),
        "F9" => Some(101),
        "F10" => Some(109),
        "F11" => Some(103),
        "F12" => Some(111),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn modifier_from_macos_keycode(keycode: i64) -> Option<ModifierKey> {
    match keycode {
        56 | 60 => Some(ModifierKey::Shift),
        59 | 62 => Some(ModifierKey::Ctrl),
        58 | 61 => Some(ModifierKey::Alt),
        55 | 54 => Some(ModifierKey::Cmd),
        _ => None,
    }
}

#[tauri::command]
fn set_hotkey(spec: HotkeySpec, state: tauri::State<'_, HotkeyState>) -> Result<(), String> {
    klog!("set_hotkey open: {:?}", spec);
    let mut guard = state
        .0
        .write()
        .map_err(|error| format!("Could not lock hotkey state: {error}"))?;
    guard.open = spec;
    Ok(())
}

#[tauri::command]
fn set_proofread_hotkey(
    spec: Option<HotkeySpec>,
    state: tauri::State<'_, HotkeyState>,
) -> Result<(), String> {
    klog!("set_hotkey proofread: {:?}", spec);
    let mut guard = state
        .0
        .write()
        .map_err(|error| format!("Could not lock hotkey state: {error}"))?;
    guard.proofread = spec;
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_hotkey_listener(app: AppHandle, hotkey: HotkeyState) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, EventField,
    };

    use std::cell::RefCell;

    /// Tracks completed modifier-only taps so we can detect double-taps.
    struct ModState {
        last_tap_release: Option<Instant>,
        is_down: bool,
        interrupted: bool,
        pending_double: bool,
    }

    impl ModState {
        const fn new() -> Self {
            Self {
                last_tap_release: None,
                is_down: false,
                interrupted: false,
                pending_double: false,
            }
        }
    }

    std::thread::spawn(move || {
        // Track all four modifiers — the user may swap which one fires the
        // double-tap at runtime, and we don't want to lose state on swap.
        let mods = RefCell::new([
            ModState::new(), // Shift
            ModState::new(), // Ctrl
            ModState::new(), // Alt
            ModState::new(), // Cmd
        ]);
        let mods_order = [
            ModifierKey::Shift,
            ModifierKey::Ctrl,
            ModifierKey::Alt,
            ModifierKey::Cmd,
        ];

        let app_for_tap = app.clone();
        let hotkey_for_tap = hotkey.clone();
        // Use the HID event stream for modifier-only double-taps. This is
        // the same tap point the original double-Alt listener used, and it is
        // more reliable for global modifier edges after the app is installed.
        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
            move |_proxy, etype, event: &CGEvent| {
                // Ignore events we synthesized ourselves — otherwise sending
                // Cmd+C as part of the proofread flow would re-trigger our
                // own double-Cmd hotkey.
                let user_data = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
                if user_data == KEN_SYNTH_USER_DATA {
                    return None;
                }
                if user_data != 0 {
                    klog!("event with user_data={:#x}", user_data);
                }

                // Snapshot specs — locking each event keeps the critical
                // section tiny and lets the UI swap bindings live.
                let hotkeys = match hotkey_for_tap.0.read() {
                    Ok(guard) => guard.clone(),
                    Err(_) => return None,
                };

                let raw_flags: u64 = event.get_flags().bits();

                #[derive(Copy, Clone)]
                enum Action {
                    Open,
                    Proofread,
                }

                let dispatch = |action: Action| {
                    let app_for_main = app_for_tap.clone();
                    let _ = app_for_tap.run_on_main_thread(move || match action {
                        Action::Open => show_palette(&app_for_main),
                        Action::Proofread => start_proofread_capture(&app_for_main),
                    });
                };

                match etype {
                    CGEventType::FlagsChanged => {
                        let changed_keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        let Some(key) = modifier_from_macos_keycode(changed_keycode) else {
                            return None;
                        };
                        let mut all = mods.borrow_mut();
                        let down = (raw_flags & key.flag()) != 0;
                        let state = &mut all[key.index()];
                        let mut dispatch_double = false;
                        if down && !state.is_down {
                            let now = Instant::now();
                            let is_double = state
                                .last_tap_release
                                .map(|last| now.duration_since(last) <= DOUBLE_ALT_WINDOW)
                                .unwrap_or(false);
                            klog!(
                                "mod-down {:?} keycode={} raw=0x{:08x} double={}",
                                key,
                                changed_keycode,
                                raw_flags,
                                is_double
                            );
                            state.is_down = true;
                            state.interrupted = false;
                            state.pending_double = is_double;
                            if is_double {
                                state.last_tap_release = None;
                            }
                        } else if !down && state.is_down {
                            klog!(
                                "mod-up {:?} keycode={} raw=0x{:08x}",
                                key,
                                changed_keycode,
                                raw_flags
                            );
                            dispatch_double = state.pending_double && !state.interrupted;
                            if !state.interrupted && !state.pending_double {
                                state.last_tap_release = Some(Instant::now());
                            }
                            state.is_down = false;
                            state.interrupted = false;
                            state.pending_double = false;
                        }

                        if dispatch_double {
                            klog!(
                                "double-tap {:?}, open={:?} proofread={:?}",
                                key,
                                hotkeys.open,
                                hotkeys.proofread
                            );
                            if let HotkeySpec::DoubleTap { key: target } = &hotkeys.open {
                                if target == &key {
                                    klog!("dispatch Open");
                                    dispatch(Action::Open);
                                }
                            }
                            if let Some(HotkeySpec::DoubleTap { key: target }) = &hotkeys.proofread
                            {
                                if target == &key {
                                    klog!("dispatch Proofread");
                                    dispatch(Action::Proofread);
                                }
                            }
                        }
                    }
                    CGEventType::KeyDown => {
                        {
                            let mut all = mods.borrow_mut();
                            for state in all.iter_mut().filter(|state| state.is_down) {
                                state.interrupted = true;
                            }
                        }

                        let pressed_keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        let have_mask: u64 = mods_order
                            .iter()
                            .fold(0u64, |acc, m| acc | (raw_flags & m.flag()));

                        let combo_matches = |spec: &HotkeySpec| -> bool {
                            let HotkeySpec::Combo { modifiers, code } = spec else {
                                return false;
                            };
                            let Some(target_keycode) = macos_keycode_for(code) else {
                                return false;
                            };
                            if pressed_keycode != target_keycode {
                                return false;
                            }
                            let want_mask: u64 =
                                modifiers.iter().fold(0u64, |acc, m| acc | m.flag());
                            want_mask != 0 && want_mask == have_mask
                        };

                        if combo_matches(&hotkeys.open) {
                            dispatch(Action::Open);
                        } else if hotkeys.proofread.as_ref().is_some_and(combo_matches) {
                            dispatch(Action::Proofread);
                        }
                    }
                    _ => {}
                }

                None
            },
        );

        let tap = match tap {
            Ok(t) => t,
            Err(_) => {
                klog!("failed to create CGEventTap (accessibility permission?)");
                return;
            }
        };

        let loop_source = match tap.mach_port.create_runloop_source(0) {
            Ok(s) => s,
            Err(_) => {
                klog!("failed to create runloop source for event tap");
                return;
            }
        };

        let current_loop = CFRunLoop::get_current();
        unsafe {
            current_loop.add_source(&loop_source, kCFRunLoopCommonModes);
        }
        tap.enable();
        klog!("hotkey listener active (HID)");
        CFRunLoop::run_current();
    });
}

#[cfg(not(target_os = "macos"))]
fn start_hotkey_listener(_app: AppHandle, _hotkey: HotkeyState) {}

#[cfg(target_os = "macos")]
fn start_proofread_capture(app: &AppHandle) {
    // Don't show the palette — proofread runs invisibly. Send Cmd+C to copy
    // the user's selection, wait briefly for the clipboard to update, then
    // emit an event the renderer turns into an LLM call + paste.
    if !accessibility_granted() {
        klog!("proofread: accessibility permission missing");
        let _ = app.emit(
            "proofread-error",
            "Enable Accessibility permission so KEN can copy and paste selected text.",
        );
        show_palette(app);
        return;
    }

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let before = read_clipboard().unwrap_or_default();
        let sentinel = format!("__KEN_SELECTION_SENTINEL_{}__", now_ms());
        if write_clipboard(&sentinel).is_err() {
            klog!("proofread: could not prime clipboard");
            let _ = app_for_thread.emit(
                "proofread-error",
                "KEN could not access the clipboard for proofreading.",
            );
            let app_for_main = app_for_thread.clone();
            let _ = app_for_thread.run_on_main_thread(move || show_palette(&app_for_main));
            return;
        }
        klog!("proofread: capturing selection");
        // Cocoa needs a tick to actually populate NSPasteboard after a synth
        // Cmd+C. 180ms is a comfortable margin in practice.
        synth_cmd_key(8 /* C */); // copy
        std::thread::sleep(Duration::from_millis(180));
        let after = read_clipboard().unwrap_or_default();
        if after.is_empty() || after == sentinel {
            let _ = write_clipboard(&before);
            klog!("proofread: clipboard unchanged — likely no selection");
            let _ = app_for_thread.emit(
                "proofread-error",
                "Select text first, then trigger the proofread hotkey.",
            );
            let app_for_main = app_for_thread.clone();
            let _ = app_for_thread.run_on_main_thread(move || show_palette(&app_for_main));
            return;
        }
        klog!("proofread: emitting request, len={}", after.len());
        let _ = app_for_thread.emit("proofread-requested", after);
    });
}

#[cfg(not(target_os = "macos"))]
fn start_proofread_capture(_app: &AppHandle) {}

/// Update the tray-icon title used as a "thinking" indicator. Empty string
/// = idle. macOS shows the title next to the icon in the menu bar, so a
/// short character is enough to flag in-flight work without stealing focus.
#[tauri::command]
fn set_tray_status(status: String, app: AppHandle) -> Result<(), String> {
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "tray not found".to_string())?;
    let label = if status.is_empty() {
        None
    } else {
        Some(status)
    };
    tray.set_title(label.as_deref())
        .map_err(|error| format!("could not update tray title: {error}"))?;
    Ok(())
}

/// Set the clipboard to `text` and synthesise Cmd+V so the selection is
/// replaced. Used by the proofread flow once the LLM returns the corrected
/// text.
#[tauri::command]
fn paste_text(text: String) -> Result<(), String> {
    write_clipboard(&text)?;
    #[cfg(target_os = "macos")]
    {
        // Pasteboard writes are async-ish — give Cocoa a beat before we ask
        // the OS to paste, otherwise the previous clipboard contents go in.
        std::thread::sleep(Duration::from_millis(60));
        synth_cmd_key(9 /* V */);
    }
    Ok(())
}

fn read_clipboard() -> Result<String, String> {
    let output = std::process::Command::new("pbpaste")
        .output()
        .map_err(|error| format!("pbpaste failed: {error}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn write_clipboard(text: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("pbcopy failed: {error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("pbcopy stdin: {error}"))?;
    }
    child
        .wait()
        .map_err(|error| format!("pbcopy wait: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn synth_cmd_key(virtual_keycode: core_graphics::event::CGKeyCode) {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, EventField};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        klog!("synth_cmd_key: could not create event source");
        return;
    };

    // Stamp every event we generate so our own tap can recognise and skip
    // them — see KEN_SYNTH_USER_DATA in the listener callback.
    let stamp = |event: &CGEvent| {
        event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, KEN_SYNTH_USER_DATA);
    };

    let cmd_keycode: core_graphics::event::CGKeyCode = 55; // Left Command

    if let Ok(cmd_down) = CGEvent::new_keyboard_event(source.clone(), cmd_keycode, true) {
        cmd_down.set_flags(CGEventFlags::CGEventFlagCommand);
        stamp(&cmd_down);
        cmd_down.post(CGEventTapLocation::HID);
    }
    if let Ok(key_down) = CGEvent::new_keyboard_event(source.clone(), virtual_keycode, true) {
        key_down.set_flags(CGEventFlags::CGEventFlagCommand);
        stamp(&key_down);
        key_down.post(CGEventTapLocation::HID);
    }
    if let Ok(key_up) = CGEvent::new_keyboard_event(source.clone(), virtual_keycode, false) {
        key_up.set_flags(CGEventFlags::CGEventFlagCommand);
        stamp(&key_up);
        key_up.post(CGEventTapLocation::HID);
    }
    if let Ok(cmd_up) = CGEvent::new_keyboard_event(source, cmd_keycode, false) {
        stamp(&cmd_up);
        cmd_up.post(CGEventTapLocation::HID);
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("PANIC: {info}"));
    }));
    klog!("---- ken starting (log: {}) ----", log_path().display());
    klog!(
        "permissions: accessibility={} input_monitoring={}",
        accessibility_granted(),
        input_monitoring_granted()
    );
    tauri::Builder::default()
        .manage(ollama::OllamaPullCancels::default())
        .manage(HotkeyState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
                let _ = window.set_shadow(false);
            }

            build_tray(app.handle())?;

            // rdev creates a CoreGraphics event tap, which conflicts with
            // macos-private-api window setup if it races during startup. Give
            // Tauri a moment to finish window/tray init before the tap spins up.
            let handle = app.handle().clone();
            let hotkey = app.state::<HotkeyState>().inner().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                start_hotkey_listener(handle, hotkey);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                let now = now_ms();
                let since_show = now.saturating_sub(LAST_SHOW_MS.load(Ordering::Relaxed));
                let focus_is_held = now <= HOLD_FOCUS_UNTIL_MS.load(Ordering::Relaxed);
                klog!("focused={} since_show={}ms", focused, since_show);
                if !focused && since_show > FOCUS_GRACE_MS && !focus_is_held {
                    hide_palette_window(&window.app_handle().clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            accessibility_status,
            begin_file_picker,
            copy_image_to_downloads,
            finish_file_picker,
            hide_palette,
            input_monitoring_status,
            open_accessibility_settings,
            open_input_monitoring_settings,
            open_ollama_download,
            open_ollama_library,
            paste_text,
            reveal_in_file_manager,
            save_generated_images,
            set_hotkey,
            set_palette_expanded,
            set_proofread_hotkey,
            set_tray_status,
            codex::ask_codex_subscription,
            codex::codex_auth_status,
            codex::codex_login,
            codex::codex_logout,
            local::ask_local_model,
            local::list_local_models,
            ollama::ask_ollama_model,
            ollama::cancel_ollama_pull,
            ollama::list_ollama_models,
            ollama::open_ollama_models_folder,
            ollama::pull_ollama_model,
            search::search_web,
        ])
        .run(tauri::generate_context!())
        .expect("error while running KEN");
}
