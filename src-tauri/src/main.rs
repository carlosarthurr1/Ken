use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

const DOUBLE_ALT_WINDOW: Duration = Duration::from_millis(430);
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

#[cfg(target_os = "macos")]
fn start_double_alt_listener(app: AppHandle) {
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, EventField,
    };

    // NSEvent modifier flag for Option/Alt (device-independent, any Option key).
    const NS_EVENT_MOD_FLAG_OPTION: u64 = 0x0008_0000;

    use std::cell::RefCell;

    struct AltState {
        last_alt: Option<Instant>,
        alt_is_down: bool,
    }

    std::thread::spawn(move || {
        let state = RefCell::new(AltState {
            last_alt: None,
            alt_is_down: false,
        });

        let app_for_tap = app.clone();
        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::FlagsChanged],
            move |_proxy, _etype, event: &CGEvent| {
                let _ = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
                let raw_flags: u64 = event.get_flags().bits();
                let option_down = (raw_flags & NS_EVENT_MOD_FLAG_OPTION) != 0;

                let mut s = state.borrow_mut();
                if option_down && !s.alt_is_down {
                    s.alt_is_down = true;
                    let now = Instant::now();
                    let is_double_tap = s
                        .last_alt
                        .map(|last| now.duration_since(last) <= DOUBLE_ALT_WINDOW)
                        .unwrap_or(false);
                    s.last_alt = Some(now);
                    if is_double_tap {
                        let app_for_main = app_for_tap.clone();
                        let _ = app_for_tap.run_on_main_thread(move || show_palette(&app_for_main));
                    }
                } else if !option_down {
                    s.alt_is_down = false;
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
        CFRunLoop::run_current();
    });
}

#[cfg(not(target_os = "macos"))]
fn start_double_alt_listener(_app: AppHandle) {}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("PANIC: {info}"));
    }));
    klog!("---- ken starting (log: {}) ----", log_path().display());
    tauri::Builder::default()
        .manage(ollama::OllamaPullCancels::default())
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
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                start_double_alt_listener(handle);
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
            begin_file_picker,
            copy_image_to_downloads,
            finish_file_picker,
            hide_palette,
            open_ollama_download,
            open_ollama_library,
            reveal_in_file_manager,
            save_generated_images,
            set_palette_expanded,
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
