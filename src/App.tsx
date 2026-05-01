import { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  CornerDownRight,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  AiResult,
  ConversationTurn,
  DEFAULT_SETTINGS,
  HotkeySpec,
  ImageAttachment,
  MODEL_OPTIONS,
  ModifierKey,
  ProviderSettings,
  SavedImage,
  askProvider,
  configuredProviderKinds,
  describeHotkey,
  getModelOption,
  groupedModelOptions,
  normalizeSettings,
  proofreadText,
} from "./lib/providers";

type Entry = {
  id: string;
  threadId: string;
  query: string;
  result: AiResult;
  createdAt: string;
};

const STORAGE_KEY = "ken.settings";
const HISTORY_KEY = "ken.history";
const HISTORY_MAX = 100;
const HISTORY_PREVIEW_COUNT = 3;
// Ollama models come from the live `installedOllamaOptions` list instead of
// the static catalog — exclude the seed Ollama entries here so we don't show
// models the user hasn't actually pulled yet.
const NON_OLLAMA_MODEL_OPTIONS = MODEL_OPTIONS.filter((option) => option.providerLabel !== "Ollama");
const MAX_ATTACHMENTS = 4;
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
const OLLAMA_LIBRARY_URL = "https://ollama.com/library";

type OllamaModelEntry = {
  name: string;
  size?: number | null;
  modifiedAt?: string | null;
};

type OllamaPullProgress = {
  pullId: string;
  model: string;
  status: string;
  completed?: number | null;
  total?: number | null;
  done: boolean;
};

type CodexAuthStatus = {
  signedIn: boolean;
  email: string | null;
  path: string;
};

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerRestoreRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activePullIdRef = useRef<string | null>(null);
  const browserPullAbortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [settings, setSettings] = useState<ProviderSettings>(() => loadSettings());
  const [entries, setEntries] = useState<Entry[]>(() => loadHistory());
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAllInlineHistory, setShowAllInlineHistory] = useState(false);
  const [error, setError] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
  const [imageActionMessage, setImageActionMessage] = useState<{ key: string; text: string } | null>(null);
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelEntry[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState("");
  const [ollamaChecked, setOllamaChecked] = useState(false);
  const [ollamaPullName, setOllamaPullName] = useState("gemma3:4b");
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  // null = unknown / not yet checked. Global hotkeys need macOS privacy
  // permissions; we surface one-click fixes when either one is missing.
  const [accessibilityGranted, setAccessibilityGranted] = useState<boolean | null>(null);
  const [inputMonitoringGranted, setInputMonitoringGranted] = useState<boolean | null>(null);
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [capturingProofread, setCapturingProofread] = useState(false);
  const [proofreadStatus, setProofreadStatus] = useState<"idle" | "thinking" | "done" | "error">("idle");

  const latestEntry = entries[0];
  const threadEntries = useMemo(
    () => (activeThreadId ? entries.filter((entry) => entry.threadId === activeThreadId) : []),
    [entries, activeThreadId],
  );
  const isFollowUp = activeThreadId !== null && threadEntries.length > 0;
  const activeModel = useMemo(
    () => getModelOption(settings.providerModel),
    [settings.providerModel],
  );
  const inlineHistoryEntries = showAllInlineHistory
    ? entries.slice(1)
    : entries.slice(1, HISTORY_PREVIEW_COUNT + 1);
  const hasMoreInlineHistory = entries.length - 1 > HISTORY_PREVIEW_COUNT;
  const installedOllamaOptions = useMemo(
    () =>
      ollamaModels
        .map((model) => ({
          id: `local/${model.name}`,
          label: model.name,
          provider: "local" as const,
          providerLabel: "Ollama",
          group: "Installed Ollama",
        })),
    [ollamaModels],
  );
  const currentOllamaOption = useMemo(() => {
    if (!settings.providerModel.startsWith("local/")) return null;
    const model = settings.providerModel.slice("local/".length);
    if (!model.includes(":")) return null;
    if (ollamaModels.some((entry) => entry.name === model)) return null;
    return {
      id: settings.providerModel,
      label: model,
      provider: "local" as const,
      providerLabel: "Ollama",
      group: "Installed Ollama",
    };
  }, [ollamaModels, settings.providerModel]);
  const configuredKinds = useMemo(
    () => configuredProviderKinds(settings, Boolean(codexAuth?.signedIn)),
    [settings, codexAuth?.signedIn],
  );
  // Only show models whose provider is configured, but always keep the
  // currently-selected model visible so the picker reflects reality.
  const visibleBaseOptions = useMemo(
    () =>
      NON_OLLAMA_MODEL_OPTIONS.filter(
        (option) => configuredKinds.has(option.provider) || option.id === settings.providerModel,
      ),
    [configuredKinds, settings.providerModel],
  );
  const modelGroups = useMemo(
    () =>
      groupedModelOptions(
        currentOllamaOption ? [currentOllamaOption, ...installedOllamaOptions] : installedOllamaOptions,
        visibleBaseOptions,
      ),
    [currentOllamaOption, installedOllamaOptions, visibleBaseOptions],
  );
  const providerIcon = activeModel.provider === "local" ? <Cpu size={14} /> : <SparkIcon />;
  const isExpanded = showSettings || showHistory || isLoading || Boolean(latestEntry) || Boolean(error);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("set_hotkey", { spec: settings.hotkey }).catch(() => undefined);
  }, [settings.hotkey]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("set_proofread_hotkey", { spec: settings.proofreadHotkey }).catch(() => undefined);
  }, [settings.proofreadHotkey]);

  // Use a ref so the listener — registered once on mount — always reads the
  // freshest provider settings, not a stale capture from when the hotkey was
  // wired up.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let busy = false;
    const unlisten = listen<string>("proofread-requested", async (event) => {
      if (busy) return;
      const text = event.payload?.toString() ?? "";
      if (!text.trim()) return;
      busy = true;
      setProofreadStatus("thinking");
      // Visible indicator in the menu bar — pencil while thinking, cleared
      // on done/error after a short delay so the user catches the change.
      invoke("set_tray_status", { status: "✎" }).catch(() => undefined);
      try {
        const corrected = await proofreadText(text, settingsRef.current);
        if (!corrected.trim()) {
          setProofreadStatus("error");
          setError("Proofread returned empty. Check your provider key.");
          return;
        }
        await invoke("paste_text", { text: corrected });
        setProofreadStatus("done");
      } catch (caught) {
        setProofreadStatus("error");
        setError((caught as Error).message || String(caught));
      } finally {
        busy = false;
        invoke("set_tray_status", { status: "" }).catch(() => undefined);
        // Reset to idle after the user has had a chance to see "done".
        window.setTimeout(() => setProofreadStatus("idle"), 1800);
      }
    });
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const unlisten = listen<string>("proofread-error", (event) => {
      const message = event.payload?.toString() || "Proofread failed.";
      setProofreadStatus("error");
      setError(message);
      if (message.toLowerCase().includes("accessibility")) {
        setShowSettings(true);
      }
      invoke<boolean>("accessibility_status")
        .then((granted) => setAccessibilityGranted(Boolean(granted)))
        .catch(() => undefined);
    });
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    refreshOllamaModels();
  }, [settings.ollamaUrl]);

  useEffect(() => {
    try {
      // Strip base64 images before persisting — they blow localStorage's
      // ~5MB quota in a handful of entries. Session memory still has them.
      const lean = entries.slice(0, HISTORY_MAX).map((entry) => ({
        ...entry,
        result: { ...entry.result, images: undefined },
      }));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(lean));
    } catch {
      /* anything still over quota — swallow */
    }
  }, [entries]);

  useEffect(() => {
    if (!showSettings) return;
    refreshOllamaModels();
    if (!window.__TAURI_INTERNALS__) return;
    let cancelled = false;
    invoke<CodexAuthStatus & { signed_in?: boolean }>("codex_auth_status")
      .then((result) => {
        if (cancelled) return;
        // Tauri serializes Rust `signed_in` → JS; accept either shape.
        const signedIn = (result as { signed_in?: boolean }).signed_in ?? result.signedIn;
        setCodexAuth({
          signedIn: Boolean(signedIn),
          email: result.email ?? null,
          path: result.path ?? "",
        });
      })
      .catch(() => {
        if (!cancelled) setCodexAuth({ signedIn: false, email: null, path: "" });
      });
    invoke<boolean>("accessibility_status")
      .then((granted) => {
        if (!cancelled) setAccessibilityGranted(Boolean(granted));
      })
      .catch(() => {
        // Command may not exist on non-macOS builds; treat as granted so we
        // don't surface a fix-it card on platforms where it's irrelevant.
        if (!cancelled) setAccessibilityGranted(true);
      });
    invoke<boolean>("input_monitoring_status")
      .then((granted) => {
        if (!cancelled) setInputMonitoringGranted(Boolean(granted));
      })
      .catch(() => {
        if (!cancelled) setInputMonitoringGranted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showSettings]);

  useLayoutEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("set_palette_expanded", { expanded: isExpanded }).catch(() => undefined);
  }, [isExpanded]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;

    const unlisten = listen("palette-opened", () => {
      window.setTimeout(() => inputRef.current?.focus(), 40);
      Promise.all([
        invoke<boolean>("accessibility_status").catch(() => true),
        invoke<boolean>("input_monitoring_status").catch(() => true),
      ]).then(([accessibility, inputMonitoring]) => {
        setAccessibilityGranted(Boolean(accessibility));
        setInputMonitoringGranted(Boolean(inputMonitoring));
        if (!accessibility || !inputMonitoring) {
          setShowSettings(true);
        }
      });
    });

    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;

    const unlisten = listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
      if (event.payload.pullId !== activePullIdRef.current) return;
      setPullProgress(event.payload);
    });

    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let lastAlt = 0;
    let altDown = false;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (showHistory) {
          setShowHistory(false);
          return;
        }
        if (activeThreadId) {
          setActiveThreadId(null);
          setQuery("");
          return;
        }
        hidePalette();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }

      if (event.key !== "Alt" || altDown) return;
      altDown = true;
      const now = Date.now();
      if (now - lastAlt < 800) {
        inputRef.current?.focus();
      }
      lastAlt = now;
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") altDown = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [showSettings, showHistory, activeThreadId]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    const submittedQuery = trimmed || (attachments.length ? "Describe the attached image." : "");
    if ((!submittedQuery && attachments.length === 0) || isLoading) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setIsLoading(true);

    const threadId = activeThreadId ?? crypto.randomUUID();
    const history: ConversationTurn[] = activeThreadId
      ? [...threadEntries]
          .reverse()
          .flatMap((entry) => [
            { role: "user" as const, content: entry.query },
            { role: "assistant" as const, content: entry.result.text },
          ])
      : [];
    const submittedImages = attachments;

    try {
      const result = await askProvider({
        query: submittedQuery,
        settings,
        signal: controller.signal,
        history,
        images: submittedImages,
      });
      const persistedResult = await persistGeneratedImages(result, submittedQuery);
      setEntries((current) => [
        {
          id: crypto.randomUUID(),
          threadId,
          query: submittedQuery,
          result: persistedResult,
          createdAt: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        ...current.slice(0, 9),
      ]);
      setActiveThreadId(threadId);
      setShowAllInlineHistory(false);
      setQuery("");
      setAttachments([]);
    } catch (caught) {
      if ((caught as Error)?.name !== "AbortError") {
        setError(errorMessage(caught));
      }
    } finally {
      setIsLoading(false);
    }
  }

  function startFollowUp() {
    if (!latestEntry) return;
    setActiveThreadId(latestEntry.threadId);
    setError("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function resetThread() {
    setActiveThreadId(null);
    setQuery("");
    setError("");
  }

  function flashImageAction(key: string, text: string) {
    setImageActionMessage({ key, text });
    window.setTimeout(() => {
      setImageActionMessage((current) => (current?.key === key ? null : current));
    }, 2200);
  }

  async function handleDownloadImage(image: { path?: string; src: string; fileName: string }, key: string) {
    if (image.path && window.__TAURI_INTERNALS__) {
      try {
        const saved = await invoke<SavedImage>("copy_image_to_downloads", { path: image.path });
        flashImageAction(key, `Saved to Downloads: ${saved.fileName}`);
      } catch (caught) {
        flashImageAction(key, errorMessage(caught));
      }
      return;
    }

    // No saved file (browser preview, or persistence skipped) — fall back to
    // a synthetic anchor click on a data URL, which the WebView *will* honor
    // because data: URLs aren't blocked by the custom-protocol gotcha.
    try {
      const anchor = document.createElement("a");
      anchor.href = image.src;
      anchor.download = image.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      flashImageAction(key, "Download started");
    } catch (caught) {
      flashImageAction(key, errorMessage(caught));
    }
  }

  async function handleRevealImage(image: { path?: string }, key: string) {
    if (!image.path || !window.__TAURI_INTERNALS__) return;
    try {
      await invoke("reveal_in_file_manager", { path: image.path });
    } catch (caught) {
      flashImageAction(key, errorMessage(caught));
    }
  }

  async function startCodexLogin() {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      await invoke("codex_login");
      // Poll for auth.json to appear. Stop after ~2 minutes.
      const started = Date.now();
      const tick = async () => {
        if (Date.now() - started > 120_000) return;
        try {
          const status = await invoke<{ signed_in?: boolean; signedIn?: boolean; email: string | null; path: string }>("codex_auth_status");
          const signedIn = status.signed_in ?? status.signedIn ?? false;
          setCodexAuth({ signedIn, email: status.email ?? null, path: status.path });
          if (!signedIn) window.setTimeout(tick, 1500);
        } catch {
          window.setTimeout(tick, 1500);
        }
      };
      window.setTimeout(tick, 1500);
    } catch (caught) {
      setError((caught as Error).message || String(caught));
    }
  }

  async function codexLogout() {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      await invoke("codex_logout");
      setCodexAuth({ signedIn: false, email: null, path: codexAuth?.path ?? "" });
    } catch (caught) {
      setError((caught as Error).message || String(caught));
    }
  }

  useEffect(() => {
    const target = capturingHotkey ? "open" : capturingProofread ? "proofread" : null;
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const code = event.code;
      const isModifierOnly =
        code === "AltLeft" ||
        code === "AltRight" ||
        code === "MetaLeft" ||
        code === "MetaRight" ||
        code === "ControlLeft" ||
        code === "ControlRight" ||
        code === "ShiftLeft" ||
        code === "ShiftRight";
      if (event.key === "Escape" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        setCapturingHotkey(false);
        setCapturingProofread(false);
        return;
      }
      if (isModifierOnly) return;
      const modifiers: ModifierKey[] = [];
      if (event.altKey) modifiers.push("alt");
      if (event.metaKey) modifiers.push("cmd");
      if (event.ctrlKey) modifiers.push("ctrl");
      if (event.shiftKey) modifiers.push("shift");
      if (modifiers.length === 0) return;
      event.preventDefault();
      const spec: HotkeySpec = { kind: "combo", modifiers, code };
      if (target === "open") {
        updateSettings({ hotkey: spec });
        setCapturingHotkey(false);
      } else {
        updateSettings({ proofreadHotkey: spec });
        setCapturingProofread(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturingHotkey, capturingProofread]);

  async function openAccessibilitySettings() {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      await invoke("open_accessibility_settings");
      // Re-check shortly after — if the user grants permission while the
      // window stays open, the card flips to the granted state.
      window.setTimeout(() => {
        invoke<boolean>("accessibility_status")
          .then((granted) => setAccessibilityGranted(Boolean(granted)))
          .catch(() => undefined);
      }, 1500);
    } catch (caught) {
      setError((caught as Error).message || String(caught));
    }
  }

  async function openInputMonitoringSettings() {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      await invoke("open_input_monitoring_settings");
      window.setTimeout(() => {
        invoke<boolean>("input_monitoring_status")
          .then((granted) => setInputMonitoringGranted(Boolean(granted)))
          .catch(() => undefined);
      }, 1500);
    } catch (caught) {
      setError((caught as Error).message || String(caught));
    }
  }

  function openHistoryEntry(entry: Entry) {
    setEntries((current) => {
      const without = current.filter((e) => e.id !== entry.id);
      return [entry, ...without].slice(0, HISTORY_MAX);
    });
    setActiveThreadId(entry.threadId);
    setShowAllInlineHistory(false);
    setShowHistory(false);
    setShowSettings(false);
    setQuery("");
  }

  function clearHistory() {
    setEntries([]);
    setActiveThreadId(null);
  }

  function dismissHistoryEntry(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }

  async function copyResult(entry: Entry) {
    try {
      await navigator.clipboard.writeText(entry.result.text || "");
      setCopiedEntryId(entry.id);
      window.setTimeout(() => {
        setCopiedEntryId((current) => (current === entry.id ? null : current));
      }, 1400);
    } catch {
      /* clipboard unavailable — swallow silently */
    }
  }

  function updateSettings(patch: Partial<ProviderSettings>) {
    setSettings((current) => normalizeSettings({ ...current, ...patch }));
  }

  async function refreshOllamaModels() {
    setOllamaStatus("");
    setOllamaChecked(false);
    try {
      const models = window.__TAURI_INTERNALS__
        ? await invoke<OllamaModelEntry[]>("list_ollama_models", {
            request: { baseUrl: settings.ollamaUrl },
          })
        : await fetchOllamaModels(settings.ollamaUrl);
      setOllamaModels(models);
    } catch (caught) {
      setOllamaModels([]);
      setOllamaStatus(String(caught));
    } finally {
      setOllamaChecked(true);
    }
  }

  async function pullOllamaModel(model: string) {
    if (pullingModel) return;
    const trimmed = model.trim();
    if (!trimmed) return;
    const pullId = crypto.randomUUID();
    activePullIdRef.current = pullId;
    browserPullAbortRef.current = null;
    setPullingModel(trimmed);
    setOllamaStatus("");
    setPullProgress({
      pullId,
      model: trimmed,
      status: "Starting download",
      completed: null,
      total: null,
      done: false,
    });
    try {
      if (window.__TAURI_INTERNALS__) {
        await invoke("pull_ollama_model", {
          request: { baseUrl: settings.ollamaUrl, model: trimmed, pullId },
        });
      } else {
        const controller = new AbortController();
        browserPullAbortRef.current = controller;
        await pullOllamaModelFromBrowser(settings.ollamaUrl, trimmed, pullId, setPullProgress, controller.signal);
      }
      await refreshOllamaModels();
      updateSettings({ providerModel: `local/${trimmed}` });
      setPullProgress((current) =>
        current?.pullId === pullId ? { ...current, status: "Downloaded", done: true } : current,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setOllamaStatus(message);
      setPullProgress((current) =>
        current?.pullId === pullId ? { ...current, status: message, done: true } : current,
      );
    } finally {
      setPullingModel(null);
      browserPullAbortRef.current = null;
      if (activePullIdRef.current === pullId) activePullIdRef.current = null;
    }
  }

  async function submitOllamaPull() {
    await pullOllamaModel(ollamaPullName);
  }

  async function cancelOllamaPull() {
    const pullId = activePullIdRef.current;
    if (!pullId) return;
    setPullProgress((current) =>
      current?.pullId === pullId ? { ...current, status: "Canceling..." } : current,
    );

    if (window.__TAURI_INTERNALS__) {
      try {
        await invoke("cancel_ollama_pull", { request: { pullId } });
      } catch (caught) {
        setOllamaStatus((caught as Error).message || String(caught));
      }
    } else {
      browserPullAbortRef.current?.abort();
    }
  }

  async function openOllamaDownload() {
    if (!window.__TAURI_INTERNALS__) {
      window.open(OLLAMA_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
      return;
    }

    try {
      await invoke("open_ollama_download");
    } catch (caught) {
      setOllamaStatus((caught as Error).message || String(caught));
    }
  }

  async function openOllamaLibrary() {
    if (!window.__TAURI_INTERNALS__) {
      window.open(OLLAMA_LIBRARY_URL, "_blank", "noopener,noreferrer");
      return;
    }

    try {
      await invoke("open_ollama_library");
    } catch (caught) {
      setOllamaStatus((caught as Error).message || String(caught));
    }
  }

  async function openOllamaModelsFolder() {
    if (!window.__TAURI_INTERNALS__) {
      setOllamaStatus("Open the desktop app to reveal the Ollama models folder. Default path: ~/.ollama/models");
      return;
    }

    try {
      const path = await invoke<string>("open_ollama_models_folder");
      setOllamaStatus(`Opened ${path}`);
    } catch (caught) {
      setOllamaStatus((caught as Error).message || String(caught));
    }
  }

  function restoreAfterFilePicker() {
    if (filePickerRestoreRef.current) {
      window.removeEventListener("focus", filePickerRestoreRef.current);
      filePickerRestoreRef.current = null;
    }
    window.setTimeout(() => {
      if (window.__TAURI_INTERNALS__) {
        invoke("finish_file_picker").catch(() => undefined);
      }
      inputRef.current?.focus();
    }, 80);
  }

  function openAttachmentPicker() {
    if (!fileInputRef.current) return;
    if (window.__TAURI_INTERNALS__) {
      if (filePickerRestoreRef.current) {
        window.removeEventListener("focus", filePickerRestoreRef.current);
      }
      invoke("begin_file_picker").catch(() => undefined);
      filePickerRestoreRef.current = restoreAfterFilePicker;
      window.addEventListener("focus", restoreAfterFilePicker, { once: true });
    }
    fileInputRef.current.click();
  }

  async function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    await addImageFiles(event.currentTarget.files);
    event.currentTarget.value = "";
    restoreAfterFilePicker();
  }

  async function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      await addImageFiles(files);
    }
  }

  async function onDrop(event: DragEvent<HTMLElement>) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    await addImageFiles(files);
  }

  async function addImageFiles(files: FileList | File[] | null) {
    if (!files) return;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;

    const remaining = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const next = await Promise.all(imageFiles.slice(0, remaining).map(readImageAttachment));
    setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return (
    <main className="shell">
      <section className={`palette ${isExpanded ? "is-expanded" : "is-collapsed"}`} aria-label="KEN search">
        <form
          className={`search ${isLoading ? "is-loading" : ""}`}
          onSubmit={onSubmit}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {isFollowUp ? (
            <CornerDownRight className="search-icon" size={20} aria-hidden="true" />
          ) : (
            <Search className="search-icon" size={22} aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onPaste={onPaste}
            placeholder={isFollowUp ? "Follow up..." : "Ask anything..."}
            spellCheck={false}
          />

          <div className="controls">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="file-input"
              onChange={onFileInputChange}
            />
            <button
              type="button"
              className={`icon-button ${attachments.length ? "active" : ""}`}
              onClick={openAttachmentPicker}
              aria-label="Attach image"
              title="Attach image"
            >
              <Paperclip size={18} />
            </button>

            <button
              type="button"
              className={`icon-button ${settings.webSearch ? "active" : ""}`}
              onClick={() => updateSettings({ webSearch: !settings.webSearch })}
              aria-label="Toggle web search"
              title="Web search"
            >
              <Globe2 size={18} />
            </button>

            <button
              type="button"
              className={`icon-button ${settings.imageGeneration ? "active" : ""}`}
              onClick={() => updateSettings({ imageGeneration: !settings.imageGeneration })}
              aria-label="Toggle image generation"
              title={
                activeModel.provider === "openai"
                  ? "Generate images with GPT Image 2"
                  : activeModel.provider === "openai-codex"
                    ? "Generate images with ChatGPT Images"
                  : "Image generation needs ChatGPT or OpenAI API"
              }
              disabled={activeModel.provider !== "openai-codex" && activeModel.provider !== "openai"}
            >
              <ImagePlus size={18} />
            </button>

            <label className="model-select" title={`${activeModel.providerLabel} · ${activeModel.label}`}>
              <span className="model-provider">{providerIcon}</span>
              <span>{activeModel.label}</span>
              <ChevronDown size={14} aria-hidden="true" />
              <select
                value={settings.providerModel}
                onChange={(event) => updateSettings({ providerModel: event.target.value })}
                onFocus={refreshOllamaModels}
                aria-label="Model"
              >
                {modelGroups.map(([group, options]) => (
                  <optgroup label={group} key={group}>
                    {options.map((option) => (
                      <option value={option.id} key={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {ollamaChecked && installedOllamaOptions.length === 0 && (
                  <optgroup label="Ollama">
                    <option value="__ollama-empty" disabled>
                      No local models installed
                    </option>
                  </optgroup>
                )}
              </select>
            </label>

            <button
              type="button"
              className={`icon-button ${showHistory ? "active" : ""}`}
              onClick={() => {
                setShowHistory((value) => !value);
                setShowSettings(false);
              }}
              aria-label="History"
              title="History"
            >
              <Clock size={18} />
            </button>

            <button
              type="button"
              className={`icon-button ${showSettings ? "active" : ""}`}
              onClick={() => {
                setShowSettings((value) => !value);
                setShowHistory(false);
              }}
              aria-label="Provider settings"
              title="Provider settings"
            >
              <Settings2 size={18} />
            </button>

            <button
              className="submit-button"
              type="submit"
              disabled={isLoading || (!query.trim() && attachments.length === 0)}
            >
              <Send className="send-icon" size={18} aria-hidden="true" />
              <LoaderCircle className="loader-icon" size={18} aria-hidden="true" />
            </button>
          </div>
        </form>

        {attachments.length > 0 && (
          <div className="attachments-bar" aria-label="Attached images">
            {attachments.map((attachment) => (
              <figure key={attachment.id} className="attachment-chip">
                <img src={attachment.dataUrl} alt="" />
                <figcaption title={attachment.name}>{attachment.name}</figcaption>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove image"
                >
                  <X size={12} />
                </button>
              </figure>
            ))}
          </div>
        )}

        {isExpanded && (
          <div className="expanded-content">
            {showSettings && (
              <section className="settings-panel" aria-label="Provider settings">
                {accessibilityGranted === false && (
                  <div className="setting-card setting-card--wide">
                    <KeyRound size={16} aria-hidden="true" />
                    <label>
                      <span>Accessibility permission</span>
                      <div className="setting-row">
                        <span className="setting-value muted">
                          The hotkey ({describeHotkey(settings.hotkey)}) needs Accessibility access.
                          macOS won't fire it until you enable it.
                        </span>
                        <button
                          type="button"
                          className="chip chip--primary"
                          onClick={openAccessibilitySettings}
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          <span>Open settings</span>
                        </button>
                      </div>
                    </label>
                  </div>
                )}

                {inputMonitoringGranted === false && (
                  <div className="setting-card setting-card--wide">
                    <KeyRound size={16} aria-hidden="true" />
                    <label>
                      <span>Input Monitoring permission</span>
                      <div className="setting-row">
                        <span className="setting-value muted">
                          The hotkey ({describeHotkey(settings.hotkey)}) needs Input Monitoring access
                          so macOS will deliver global key events.
                        </span>
                        <button
                          type="button"
                          className="chip chip--primary"
                          onClick={openInputMonitoringSettings}
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          <span>Open settings</span>
                        </button>
                      </div>
                    </label>
                  </div>
                )}

                <div className="setting-card setting-card--wide">
                  <Cpu size={16} aria-hidden="true" />
                  <label>
                    <span>Hotkey</span>
                    <div className="setting-grid">
                      <select
                        value={settings.hotkey.kind}
                        onChange={(event) => {
                          const kind = event.target.value as HotkeySpec["kind"];
                          if (kind === "double-tap") {
                            updateSettings({ hotkey: { kind: "double-tap", key: "alt" } });
                          } else {
                            updateSettings({
                              hotkey: { kind: "combo", modifiers: ["cmd"], code: "Space" },
                            });
                          }
                          setCapturingHotkey(false);
                        }}
                        aria-label="Hotkey type"
                      >
                        <option value="double-tap">Double-tap modifier</option>
                        <option value="combo">Key combination</option>
                      </select>
                      {settings.hotkey.kind === "double-tap" ? (
                        <select
                          value={settings.hotkey.key}
                          onChange={(event) =>
                            updateSettings({
                              hotkey: {
                                kind: "double-tap",
                                key: event.target.value as ModifierKey,
                              },
                            })
                          }
                          aria-label="Modifier key"
                        >
                          <option value="alt">⌥ Option</option>
                          <option value="cmd">⌘ Command</option>
                          <option value="ctrl">⌃ Control</option>
                          <option value="shift">⇧ Shift</option>
                        </select>
                      ) : (
                        <button
                          type="button"
                          className={`chip ${capturingHotkey ? "is-confirmed" : ""}`}
                          onClick={() => setCapturingHotkey((v) => !v)}
                          aria-label="Record key combination"
                        >
                          <span>
                            {capturingHotkey
                              ? "Press shortcut… (Esc to cancel)"
                              : describeHotkey(settings.hotkey)}
                          </span>
                        </button>
                      )}
                    </div>
                    <span className="setting-note">
                      {settings.hotkey.kind === "double-tap"
                        ? `Tap ${describeHotkey(settings.hotkey).replace("Double ", "")} twice within ~800ms to summon KEN.`
                        : "Hold modifiers and tap a key. The combo must include at least one modifier."}
                    </span>
                  </label>
                </div>

                <div className="setting-card setting-card--wide">
                  <Sparkles size={16} aria-hidden="true" />
                  <label>
                    <span>Proofread selection</span>
                    <div className="setting-grid">
                      <select
                        value={
                          settings.proofreadHotkey === null
                            ? "off"
                            : settings.proofreadHotkey.kind
                        }
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "off") {
                            updateSettings({ proofreadHotkey: null });
                          } else if (value === "double-tap") {
                            updateSettings({
                              proofreadHotkey: { kind: "double-tap", key: "shift" },
                            });
                          } else {
                            updateSettings({
                              proofreadHotkey: {
                                kind: "combo",
                                modifiers: ["cmd", "shift"],
                                code: "KeyP",
                              },
                            });
                          }
                          setCapturingProofread(false);
                        }}
                        aria-label="Proofread hotkey type"
                      >
                        <option value="off">Off</option>
                        <option value="double-tap">Double-tap modifier</option>
                        <option value="combo">Key combination</option>
                      </select>
                      {settings.proofreadHotkey?.kind === "double-tap" && (
                        <select
                          value={settings.proofreadHotkey.key}
                          onChange={(event) =>
                            updateSettings({
                              proofreadHotkey: {
                                kind: "double-tap",
                                key: event.target.value as ModifierKey,
                              },
                            })
                          }
                          aria-label="Proofread modifier key"
                        >
                          <option value="alt">⌥ Option</option>
                          <option value="cmd">⌘ Command</option>
                          <option value="ctrl">⌃ Control</option>
                          <option value="shift">⇧ Shift</option>
                        </select>
                      )}
                      {settings.proofreadHotkey?.kind === "combo" && (
                        <button
                          type="button"
                          className={`chip ${capturingProofread ? "is-confirmed" : ""}`}
                          onClick={() => setCapturingProofread((v) => !v)}
                          aria-label="Record proofread combination"
                        >
                          <span>
                            {capturingProofread
                              ? "Press shortcut… (Esc to cancel)"
                              : describeHotkey(settings.proofreadHotkey)}
                          </span>
                        </button>
                      )}
                    </div>
                    <span className="setting-note">
                      Highlights any text, fires the hotkey, KEN replaces it with a proofread
                      version using your selected model. No em-dashes.
                    </span>
                  </label>
                </div>

                <div className="setting-card setting-card--wide">
                  <Sparkles size={16} aria-hidden="true" />
                  <label>
                    <span>ChatGPT subscription</span>
                    {codexAuth?.signedIn ? (
                      <div className="setting-row">
                        <span className="setting-value">
                          Signed in{codexAuth.email ? ` as ${codexAuth.email}` : ""}
                        </span>
                        <button type="button" className="chip" onClick={codexLogout}>
                          <LogOut size={14} aria-hidden="true" />
                          <span>Sign out</span>
                        </button>
                      </div>
                    ) : (
                      <div className="setting-row">
                        <span className="setting-value muted">
                          Not signed in — opens Terminal to run <code>codex login</code>.
                        </span>
                        <button type="button" className="chip chip--primary" onClick={startCodexLogin}>
                          <LogIn size={14} aria-hidden="true" />
                          <span>Sign in</span>
                        </button>
                      </div>
                    )}
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>OpenAI key</span>
                    <input
                      value={settings.openaiApiKey}
                      onChange={(event) => updateSettings({ openaiApiKey: event.target.value })}
                      placeholder="sk-..."
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>Z.ai (GLM / Coder)</span>
                    <input
                      value={settings.zaiApiKey}
                      onChange={(event) => updateSettings({ zaiApiKey: event.target.value })}
                      placeholder="z.ai API key"
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>OpenRouter</span>
                    <input
                      value={settings.openrouterApiKey}
                      onChange={(event) => updateSettings({ openrouterApiKey: event.target.value })}
                      placeholder="sk-or-..."
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>DeepSeek</span>
                    <input
                      value={settings.deepseekApiKey}
                      onChange={(event) => updateSettings({ deepseekApiKey: event.target.value })}
                      placeholder="DeepSeek API key"
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>Google Gemini</span>
                    <input
                      value={settings.googleApiKey}
                      onChange={(event) => updateSettings({ googleApiKey: event.target.value })}
                      placeholder="Gemini API key"
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>Groq</span>
                    <input
                      value={settings.groqApiKey}
                      onChange={(event) => updateSettings({ groqApiKey: event.target.value })}
                      placeholder="gsk_..."
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card">
                  <KeyRound size={16} aria-hidden="true" />
                  <label>
                    <span>Mistral</span>
                    <input
                      value={settings.mistralApiKey}
                      onChange={(event) => updateSettings({ mistralApiKey: event.target.value })}
                      placeholder="Mistral API key"
                      type="password"
                    />
                  </label>
                </div>

                <div className="setting-card setting-card--wide">
                  <Globe2 size={16} aria-hidden="true" />
                  <label>
                    <span>Local web search</span>
                    <div className="setting-grid">
                      <select
                        value={settings.searchProvider}
                        onChange={(event) =>
                          updateSettings({ searchProvider: event.target.value as ProviderSettings["searchProvider"] })
                        }
                        aria-label="Local search provider"
                      >
                        <option value="tavily">Tavily</option>
                        <option value="brave">Brave Search</option>
                      </select>
                      <input
                        value={settings.searchProvider === "brave" ? settings.braveApiKey : settings.tavilyApiKey}
                        onChange={(event) =>
                          settings.searchProvider === "brave"
                            ? updateSettings({ braveApiKey: event.target.value })
                            : updateSettings({ tavilyApiKey: event.target.value })
                        }
                        placeholder={settings.searchProvider === "brave" ? "Brave API key" : "tvly-..."}
                        type="password"
                      />
                    </div>
                  </label>
                </div>

                <div className="setting-card setting-card--wide">
                  <Cpu size={16} aria-hidden="true" />
                  <label>
                    <div className="setting-head">
                      <span>Ollama models</span>
                      <div className="setting-actions">
                        <button
                          type="button"
                          className="chip"
                          onClick={openOllamaModelsFolder}
                          aria-label="Open Ollama models folder"
                          title="Open Ollama models folder"
                        >
                          <FolderOpen size={14} aria-hidden="true" />
                          <span>Folder</span>
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={openOllamaDownload}
                          aria-label="Install Ollama"
                          title="Install Ollama"
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          <span>Install Ollama</span>
                        </button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <input
                        value={settings.ollamaUrl}
                        onChange={(event) => updateSettings({ ollamaUrl: event.target.value })}
                        placeholder="http://localhost:11434"
                      />
                      <button type="button" className="chip" onClick={refreshOllamaModels} title="Refresh models">
                        <RefreshCw size={14} aria-hidden="true" />
                        <span>Refresh</span>
                      </button>
                    </div>
                    <div className="setting-grid setting-grid--ollama-pull">
                      <input
                        value={ollamaPullName}
                        onChange={(event) => setOllamaPullName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            submitOllamaPull();
                          }
                        }}
                        placeholder="gemma3:4b"
                        aria-label="Ollama model name"
                      />
                      <div className="setting-row setting-row--compact">
                        <button
                          type="button"
                          className="chip chip--primary"
                          onClick={submitOllamaPull}
                          disabled={Boolean(pullingModel) || !ollamaPullName.trim()}
                          aria-label={`Pull ${ollamaPullName || "Ollama model"}`}
                        >
                          {pullingModel ? (
                            <LoaderCircle size={14} aria-hidden="true" />
                          ) : (
                            <Download size={14} aria-hidden="true" />
                          )}
                          <span>{pullingModel ? "Pulling" : "Pull"}</span>
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={openOllamaLibrary}
                          aria-label="Browse Ollama library"
                          title="Browse Ollama library"
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          <span>Library</span>
                        </button>
                      </div>
                    </div>
                    {pullProgress && (
                      <div className="pull-progress" aria-label="Ollama download progress">
                        <div className="pull-progress-head">
                          <strong>{pullProgress.model}</strong>
                          <span>{formatPullProgress(pullProgress)}</span>
                        </div>
                        <div className="pull-progress-bar" aria-hidden="true">
                          <i style={{ width: `${pullProgressPercent(pullProgress)}%` }} />
                        </div>
                        <div className="pull-progress-foot">
                          <span>{pullProgress.status}</span>
                          {pullingModel && (
                            <button
                              type="button"
                              className="chip"
                              onClick={cancelOllamaPull}
                              aria-label={`Cancel ${pullProgress.model} download`}
                            >
                              <X size={14} aria-hidden="true" />
                              <span>Cancel</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="local-models">
                      {ollamaModels.length > 0 && (
                        <>
                          <span className="local-section-title">Installed on this machine</span>
                          {ollamaModels.map((model) => {
                            const id = `local/${model.name}`;
                            const selected = settings.providerModel === id;
                            return (
                              <div className="local-model-row" key={model.name}>
                                <div>
                                  <strong>{model.name}</strong>
                                  <small>{formatOllamaMeta(model)}</small>
                                </div>
                                <button
                                  type="button"
                                  className={`chip ${selected ? "is-confirmed" : ""}`}
                                  onClick={() => updateSettings({ providerModel: id })}
                                  aria-label={`${selected ? "Selected" : "Use"} ${model.name}`}
                                >
                                  <Check size={14} aria-hidden="true" />
                                  <span>{selected ? "Selected" : "Use"}</span>
                                </button>
                              </div>
                            );
                          })}
                        </>
                      )}
                      {ollamaChecked && !ollamaStatus && ollamaModels.length === 0 && (
                        <span className="setting-note">No installed Ollama models detected.</span>
                      )}
                    </div>
                    {ollamaStatus && <span className="setting-note">{ollamaStatus}</span>}
                  </label>
                </div>
              </section>
            )}

            {showHistory && (
              <section className="history-panel" aria-label="Search history">
                <div className="history-panel-head">
                  <span>Recent searches</span>
                  {entries.length > 0 && (
                    <button type="button" className="chip" onClick={clearHistory} title="Clear history">
                      <Trash2 size={14} aria-hidden="true" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
                {entries.length === 0 ? (
                  <p className="history-empty">No searches yet. Ask something and it lands here.</p>
                ) : (
                  <ul className="history-list">
                    {entries.map((entry) => (
                      <li key={entry.id} className="history-list-item">
                        <button
                          type="button"
                          className="history-list-main"
                          onClick={() => openHistoryEntry(entry)}
                        >
                          <span className="history-query">{entry.query}</span>
                          <span className="history-meta">
                            {entry.result.providerLabel} · {entry.createdAt}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="history-dismiss"
                          onClick={() => dismissHistoryEntry(entry.id)}
                          aria-label={`Dismiss ${entry.query}`}
                          title="Dismiss"
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {error && <p className="error">{error}</p>}

            {(isLoading || latestEntry) && (
              <section className="answer" aria-live="polite">
                {isLoading ? (
                  <article className="thinking">
                    <div>
                      <LoaderCircle size={18} />
                      <span>{activeModel.providerLabel}</span>
                    </div>
                    <div className="thinking-lines" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                  </article>
                ) : latestEntry ? (
                  <article className="result">
                    <div className="result-meta">
                      <span>
                        {latestEntry.result.providerLabel} · {latestEntry.result.modelLabel}
                        {isFollowUp && threadEntries.length > 1
                          ? ` · ${threadEntries.length} turns`
                          : ""}
                      </span>
                      <span>{latestEntry.createdAt}</span>
                    </div>
                    <h1>{latestEntry.query}</h1>
                    {latestEntry.result.text && (
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {latestEntry.result.text}
                        </ReactMarkdown>
                      </div>
                    )}
                    {getDisplayImages(latestEntry.result).length > 0 && (
                      <div className="images">
                        {getDisplayImages(latestEntry.result).map((image, i) => {
                          const key = `${image.href}-${i}`;
                          const message = imageActionMessage?.key === key ? imageActionMessage.text : null;
                          return (
                            <figure className="image-card" key={key}>
                              <a
                                className="image-preview"
                                href={image.href}
                                target="_blank"
                                rel="noreferrer"
                                title={image.title}
                              >
                                <img src={image.src} alt="" />
                              </a>
                              <figcaption>
                                <span title={image.path ?? image.fileName}>
                                  {message ?? image.fileName}
                                </span>
                                <span className="image-actions">
                                  {Boolean(image.path && window.__TAURI_INTERNALS__) && (
                                    <button
                                      type="button"
                                      onClick={() => handleRevealImage(image, key)}
                                      title="Show in Finder/Explorer"
                                    >
                                      <FolderOpen size={13} aria-hidden="true" />
                                      <span>Show</span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleDownloadImage(image, key)}
                                    title="Save a copy to Downloads"
                                  >
                                    <Download size={13} aria-hidden="true" />
                                    <span>Download</span>
                                  </button>
                                </span>
                              </figcaption>
                            </figure>
                          );
                        })}
                      </div>
                    )}
                    {latestEntry.result.sources && latestEntry.result.sources.length > 0 && (
                      <div className="sources">
                        {latestEntry.result.sources.map((source) => (
                          <a href={source.url} key={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="result-actions">
                      <button type="button" className="chip" onClick={startFollowUp}>
                        <CornerDownRight size={14} aria-hidden="true" />
                        <span>Follow up</span>
                      </button>
                      {latestEntry.result.text && (
                        <button
                          type="button"
                          className={`chip ${copiedEntryId === latestEntry.id ? "is-confirmed" : ""}`}
                          onClick={() => copyResult(latestEntry)}
                          aria-label="Copy answer"
                        >
                          {copiedEntryId === latestEntry.id ? (
                            <>
                              <Check size={14} aria-hidden="true" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy size={14} aria-hidden="true" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      )}
                      {isFollowUp && (
                        <button type="button" className="chip" onClick={resetThread}>
                          <X size={14} aria-hidden="true" />
                          <span>New thread</span>
                        </button>
                      )}
                    </div>
                  </article>
                ) : null}

                {entries.length > 1 && !isLoading && (
                  <div className="history">
                    {inlineHistoryEntries.map((entry) => (
                      <div className="history-item" key={entry.id}>
                        <button
                          type="button"
                          className="history-reuse"
                          onClick={() => setQuery(entry.query)}
                          title={entry.query}
                        >
                          <span>{entry.query}</span>
                          <small>{entry.createdAt}</small>
                        </button>
                        <button
                          type="button"
                          className="history-dismiss"
                          onClick={() => dismissHistoryEntry(entry.id)}
                          aria-label={`Dismiss ${entry.query}`}
                          title="Dismiss"
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    {hasMoreInlineHistory && (
                      <button
                        type="button"
                        className="history-load-more"
                        onClick={() => setShowAllInlineHistory((value) => !value)}
                      >
                        <span>{showAllInlineHistory ? "Show less" : "Load more"}</span>
                        <small>{entries.length - 1} total</small>
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function loadSettings(): ProviderSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadHistory(): Entry[] {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Entry => {
        return (
          entry &&
          typeof entry.id === "string" &&
          typeof entry.query === "string" &&
          entry.result &&
          typeof entry.result.text === "string"
        );
      })
      .map((entry) => ({
        ...entry,
        threadId: entry.threadId || entry.id,
      }))
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function formatOllamaMeta(model: OllamaModelEntry) {
  const details = [formatBytes(model.size), formatDate(model.modifiedAt)].filter(Boolean);
  return details.length ? details.join(" · ") : "Installed";
}

function pullProgressPercent(progress: OllamaPullProgress) {
  if (!progress.total || progress.total <= 0 || !progress.completed) {
    return progress.done ? 100 : 2;
  }
  return Math.max(2, Math.min(100, Math.round((progress.completed / progress.total) * 100)));
}

function formatPullProgress(progress: OllamaPullProgress) {
  if (progress.total && progress.completed) {
    return `${formatBytes(progress.completed)} / ${formatBytes(progress.total)}`;
  }
  if (progress.done) return "Done";
  return "Preparing";
}

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function fetchOllamaModels(baseUrl: string): Promise<OllamaModelEntry[]> {
  let response: Response;
  try {
    response = await fetch(ollamaApiUrl(baseUrl, "/api/tags"));
  } catch (caught) {
    throw new Error(formatOllamaBrowserError(caught));
  }

  if (!response.ok) {
    throw new Error(await readOllamaFetchError("Ollama model list failed", response));
  }

  const body = await response.json();
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .map((model: Record<string, unknown>) => ({
      name: typeof model.model === "string" ? model.model : typeof model.name === "string" ? model.name : "",
      size: typeof model.size === "number" ? model.size : null,
      modifiedAt:
        typeof model.modified_at === "string"
          ? model.modified_at
          : typeof model.modifiedAt === "string"
            ? model.modifiedAt
            : null,
    }))
    .filter((model: OllamaModelEntry) => model.name);
}

async function pullOllamaModelFromBrowser(
  baseUrl: string,
  model: string,
  pullId: string,
  onProgress: (progress: OllamaPullProgress) => void,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(ollamaApiUrl(baseUrl, "/api/pull"), {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });
  } catch (caught) {
    if ((caught as Error).name === "AbortError") {
      throw new Error("Model download canceled.");
    }
    throw new Error(formatOllamaBrowserError(caught));
  }

  if (!response.ok) {
    throw new Error(await readOllamaFetchError("Ollama model download failed", response));
  }

  if (!response.body) {
    onProgress({ pullId, model, status: "Downloaded", done: true });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (caught) {
      if ((caught as Error).name === "AbortError") {
        throw new Error("Model download canceled.");
      }
      throw caught;
    }

    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      emitBrowserPullLine(line, pullId, model, onProgress);
    }
  }

  buffer += decoder.decode();
  emitBrowserPullLine(buffer, pullId, model, onProgress);
}

function emitBrowserPullLine(
  line: string,
  pullId: string,
  model: string,
  onProgress: (progress: OllamaPullProgress) => void,
) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const value = JSON.parse(trimmed) as { status?: string; completed?: number; total?: number };
  const status = value.status || "Downloading";
  onProgress({
    pullId,
    model,
    status,
    completed: value.completed ?? null,
    total: value.total ?? null,
    done: status.toLowerCase() === "success",
  });
}

function ollamaApiUrl(baseUrl: string, path: string) {
  return `${(baseUrl || "http://localhost:11434").replace(/\/+$/, "")}${path}`;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message || "Request failed.";
  if (typeof caught === "string" && caught.trim()) return caught;
  if (caught && typeof caught === "object") {
    const maybe = caught as { message?: unknown };
    if (typeof maybe.message === "string" && maybe.message.trim()) return maybe.message;
  }
  return "Request failed.";
}

function formatOllamaBrowserError(caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message.toLowerCase().includes("failed to fetch")) {
    return "Ollama is not running. Install or start Ollama, then refresh models.";
  }
  return `Ollama request failed: ${message}`;
}

async function readOllamaFetchError(prefix: string, response: Response) {
  try {
    const body = await response.text();
    return body ? `${prefix}: ${body}` : `${prefix}: ${response.status} ${response.statusText}`;
  } catch {
    return `${prefix}: ${response.status} ${response.statusText}`;
  }
}

async function persistGeneratedImages(result: AiResult, prompt: string): Promise<AiResult> {
  if (!window.__TAURI_INTERNALS__ || !result.images?.length) return result;

  try {
    const imageFiles = await invoke<SavedImage[]>("save_generated_images", {
      request: {
        prompt,
        images: result.images,
      },
    });
    return { ...result, imageFiles };
  } catch {
    return result;
  }
}

function getDisplayImages(result: AiResult) {
  if (result.imageFiles?.length) {
    return result.imageFiles.map((image) => {
      const src = window.__TAURI_INTERNALS__ ? convertFileSrc(image.path) : image.path;
      return {
        src,
        href: src,
        fileName: image.fileName,
        path: image.path,
        title: `Saved to ${image.path}`,
      };
    });
  }

  return (
    result.images?.map((b64, index) => {
      const src = `data:image/png;base64,${b64}`;
      return {
        src,
        href: src,
        fileName: `ken-generated-${index + 1}.png`,
        path: undefined,
        title: "Download image",
      };
    }) ?? []
  );
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      resolve({
        id: crypto.randomUUID(),
        name: file.name || "image",
        mimeType: file.type || "image/png",
        dataUrl,
        base64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function hidePalette() {
  if (!window.__TAURI_INTERNALS__) return;
  invoke("hide_palette").catch(() => undefined);
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M7.2 1.5 8 5.1l3.5.8-3.5.9-.8 3.5-.9-3.5-3.5-.9 3.5-.8.9-3.6Z"
        fill="currentColor"
      />
    </svg>
  );
}
