import { invoke } from "@tauri-apps/api/core";

export type ProviderKind =
  | "mock"
  | "openai-codex"
  | "openai"
  | "local"
  | "zai"
  | "zai-coding"
  | "openrouter"
  | "deepseek"
  | "google"
  | "groq"
  | "mistral";

export type ModelOption = {
  id: string;
  label: string;
  provider: ProviderKind;
  providerLabel: string;
  group: string;
};

export type ModifierKey = "alt" | "cmd" | "ctrl" | "shift";

export type HotkeySpec =
  | { kind: "double-tap"; key: ModifierKey }
  | { kind: "combo"; modifiers: ModifierKey[]; code: string };

export type ProviderSettings = {
  providerModel: string;
  openaiApiKey: string;
  zaiApiKey: string;
  openrouterApiKey: string;
  deepseekApiKey: string;
  googleApiKey: string;
  groqApiKey: string;
  mistralApiKey: string;
  webSearch: boolean;
  imageGeneration: boolean;
  ollamaUrl: string;
  searchProvider: "tavily" | "brave";
  tavilyApiKey: string;
  braveApiKey: string;
  hotkey: HotkeySpec;
  /** Off when null. Triggers system-wide selection → proofread → paste. */
  proofreadHotkey: HotkeySpec | null;
};

type OpenAICompatConfig = {
  baseUrl: string;
  providerLabel: string;
  apiKeyField: keyof ProviderSettings;
  /** Z.ai endpoints accept a non-standard `thinking` toggle instead of OpenAI's `reasoning_effort`. */
  zaiThinking?: boolean;
};

export const OPENAI_COMPAT_CONFIG: Partial<Record<ProviderKind, OpenAICompatConfig>> = {
  zai: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    providerLabel: "Z.ai (GLM)",
    apiKeyField: "zaiApiKey",
    zaiThinking: true,
  },
  "zai-coding": {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    providerLabel: "Z.ai Coder",
    apiKeyField: "zaiApiKey",
    zaiThinking: true,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    providerLabel: "OpenRouter",
    apiKeyField: "openrouterApiKey",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    providerLabel: "DeepSeek",
    apiKeyField: "deepseekApiKey",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    providerLabel: "Google Gemini",
    apiKeyField: "googleApiKey",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    providerLabel: "Groq",
    apiKeyField: "groqApiKey",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    providerLabel: "Mistral",
    apiKeyField: "mistralApiKey",
  },
};

export type Source = {
  title: string;
  url: string;
};

export type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  base64: string;
};

export type SavedImage = {
  path: string;
  fileName: string;
};

export type AiResult = {
  text: string;
  sources?: Source[];
  /** Base64-encoded PNGs returned by the image_generation tool. */
  images?: string[];
  /** Native filesystem paths for images persisted by KEN. */
  imageFiles?: SavedImage[];
  providerLabel: string;
  modelLabel: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type AskOptions = {
  query: string;
  settings: ProviderSettings;
  signal?: AbortSignal;
  history?: ConversationTurn[];
  images?: ImageAttachment[];
};

// Same catalog as Sumi so a user who installed a GGUF there doesn't have
// to download it again — KEN detects shared files via the Rust backend.
export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "openai-codex/gpt-5.5",
    label: "GPT-5.5",
    provider: "openai-codex",
    providerLabel: "ChatGPT",
    group: "ChatGPT subscription",
  },
  {
    id: "openai-codex/gpt-5.4",
    label: "GPT-5.4",
    provider: "openai-codex",
    providerLabel: "ChatGPT",
    group: "ChatGPT subscription",
  },
  {
    id: "openai-codex/gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    provider: "openai-codex",
    providerLabel: "ChatGPT",
    group: "ChatGPT subscription",
  },
  {
    id: "openai-codex/gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    provider: "openai-codex",
    providerLabel: "ChatGPT",
    group: "ChatGPT subscription",
  },
  {
    id: "openai/gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    providerLabel: "OpenAI API",
    group: "API key",
  },
  {
    id: "openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    provider: "openai",
    providerLabel: "OpenAI API",
    group: "API key",
  },
  {
    id: "zai-coding/glm-4.6",
    label: "GLM-4.6 (Coder)",
    provider: "zai-coding",
    providerLabel: "Z.ai Coder",
    group: "Z.ai (GLM)",
  },
  {
    id: "zai/glm-4.6",
    label: "GLM-4.6",
    provider: "zai",
    providerLabel: "Z.ai (GLM)",
    group: "Z.ai (GLM)",
  },
  {
    id: "zai/glm-4.5",
    label: "GLM-4.5",
    provider: "zai",
    providerLabel: "Z.ai (GLM)",
    group: "Z.ai (GLM)",
  },
  {
    id: "zai/glm-4.5-air",
    label: "GLM-4.5 Air",
    provider: "zai",
    providerLabel: "Z.ai (GLM)",
    group: "Z.ai (GLM)",
  },
  {
    id: "zai/glm-4.5v",
    label: "GLM-4.5V (Vision)",
    provider: "zai",
    providerLabel: "Z.ai (GLM)",
    group: "Z.ai (GLM)",
  },
  {
    id: "openrouter/anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    group: "OpenRouter",
  },
  {
    id: "openrouter/x-ai/grok-4",
    label: "Grok 4",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    group: "OpenRouter",
  },
  {
    id: "openrouter/meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    group: "OpenRouter",
  },
  {
    id: "openrouter/google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    group: "OpenRouter",
  },
  {
    id: "deepseek/deepseek-chat",
    label: "DeepSeek Chat",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    group: "DeepSeek",
  },
  {
    id: "deepseek/deepseek-reasoner",
    label: "DeepSeek Reasoner",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    group: "DeepSeek",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    providerLabel: "Google Gemini",
    group: "Google Gemini",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    providerLabel: "Google Gemini",
    group: "Google Gemini",
  },
  {
    id: "groq/llama-3.3-70b-versatile",
    label: "Llama 3.3 70B (Groq)",
    provider: "groq",
    providerLabel: "Groq",
    group: "Groq",
  },
  {
    id: "groq/moonshotai/kimi-k2-instruct",
    label: "Kimi K2 (Groq)",
    provider: "groq",
    providerLabel: "Groq",
    group: "Groq",
  },
  {
    id: "groq/qwen/qwen3-32b",
    label: "Qwen 3 32B (Groq)",
    provider: "groq",
    providerLabel: "Groq",
    group: "Groq",
  },
  {
    id: "mistral/mistral-large-latest",
    label: "Mistral Large",
    provider: "mistral",
    providerLabel: "Mistral",
    group: "Mistral",
  },
  {
    id: "mistral/codestral-latest",
    label: "Codestral",
    provider: "mistral",
    providerLabel: "Mistral",
    group: "Mistral",
  },
  {
    id: "local/gemma3:4b",
    label: "Gemma 3 4B Vision",
    provider: "local",
    providerLabel: "Ollama",
    group: "Local (Ollama)",
  },
  {
    id: "local/qwen2.5vl:3b",
    label: "Qwen 2.5 VL 3B",
    provider: "local",
    providerLabel: "Ollama",
    group: "Local (Ollama)",
  },
  {
    id: "local/llama3.2-vision:11b",
    label: "Llama 3.2 Vision 11B",
    provider: "local",
    providerLabel: "Ollama",
    group: "Local (Ollama)",
  },
  {
    id: "local/qwen2.5:3b",
    label: "Qwen 2.5 3B",
    provider: "local",
    providerLabel: "Ollama",
    group: "Local (Ollama)",
  },
  {
    id: "local/qwen2.5:1.5b",
    label: "Qwen 2.5 1.5B",
    provider: "local",
    providerLabel: "Ollama",
    group: "Local (Ollama)",
  },
  {
    id: "local/qwen2.5-1.5b",
    label: "Qwen 2.5 1.5B",
    provider: "local",
    providerLabel: "GGUF",
    group: "Local GGUF fallback",
  },
  {
    id: "local/qwen2.5-3b",
    label: "Qwen 2.5 3B",
    provider: "local",
    providerLabel: "GGUF",
    group: "Local GGUF fallback",
  },
  {
    id: "local/gemma4-2b",
    label: "Gemma 4 2B",
    provider: "local",
    providerLabel: "GGUF",
    group: "Local GGUF fallback",
  },
  {
    id: "local/gemma4-4b",
    label: "Gemma 4 4B",
    provider: "local",
    providerLabel: "GGUF",
    group: "Local GGUF fallback",
  },
  {
    id: "mock/preview",
    label: "Preview",
    provider: "mock",
    providerLabel: "Mock",
    group: "Preview",
  },
];

export const DEFAULT_HOTKEY: HotkeySpec = { kind: "double-tap", key: "alt" };

export const DEFAULT_SETTINGS: ProviderSettings = {
  providerModel: "openai-codex/gpt-5.5",
  openaiApiKey: "",
  zaiApiKey: "",
  openrouterApiKey: "",
  deepseekApiKey: "",
  googleApiKey: "",
  groqApiKey: "",
  mistralApiKey: "",
  webSearch: false,
  imageGeneration: false,
  ollamaUrl: "http://localhost:11434",
  searchProvider: "tavily",
  tavilyApiKey: "",
  braveApiKey: "",
  hotkey: DEFAULT_HOTKEY,
  proofreadHotkey: null,
};

const ALL_PROVIDER_KINDS: ProviderKind[] = [
  "mock",
  "openai-codex",
  "openai",
  "local",
  "zai",
  "zai-coding",
  "openrouter",
  "deepseek",
  "google",
  "groq",
  "mistral",
];

/**
 * Returns true when the user has the credentials/runtime needed to call this
 * provider. Used to filter the quick-toggle model picker so users only see
 * models they can actually run.
 *
 *   - mock / local: always available (preview + native llama.cpp / Ollama)
 *   - openai-codex: requires Codex OAuth sign-in (passed in by caller)
 *   - openai: requires OPENAI API key
 *   - zai / zai-coding: share a single ZAI key
 *   - rest: their own API key field
 */
export function isProviderConfigured(
  kind: ProviderKind,
  settings: ProviderSettings,
  codexSignedIn: boolean,
): boolean {
  switch (kind) {
    case "mock":
    case "local":
      return true;
    case "openai-codex":
      return codexSignedIn;
    case "openai":
      return Boolean(settings.openaiApiKey.trim());
    default: {
      const config = OPENAI_COMPAT_CONFIG[kind];
      if (!config) return false;
      const key = settings[config.apiKeyField];
      return typeof key === "string" && key.trim().length > 0;
    }
  }
}

export function configuredProviderKinds(
  settings: ProviderSettings,
  codexSignedIn: boolean,
): Set<ProviderKind> {
  const result = new Set<ProviderKind>();
  for (const kind of ALL_PROVIDER_KINDS) {
    if (isProviderConfigured(kind, settings, codexSignedIn)) result.add(kind);
  }
  return result;
}

const DIRECT_SYSTEM_PROMPT =
  "Answer directly. Keep it under 90 words unless the user asks for depth. Prefer short bullets. No preamble.";
const GPT_IMAGE_MODEL = "gpt-image-2";

const PROOFREAD_SYSTEM_PROMPT = [
  "You are a proofreader. Fix grammar, spelling, and clarity issues in the user's text.",
  "Keep the original tone, meaning, and language. Do not translate. Do not add or remove ideas.",
  "CRITICAL RULE: Never use em-dashes. Replace any em-dash characters with commas, periods, parentheses, or colons, whichever fits best.",
  "Return ONLY the corrected text. No quotes, no preamble, no explanation, no markdown.",
].join(" ");

/**
 * Run the configured provider against a piece of user-selected text and
 * return the proofread version. Used by the system-wide "proofread
 * selection" hotkey — the result is pasted back into the user's app, so we
 * strip any em-dashes the model slipped in despite the prompt.
 */
export async function proofreadText(
  selection: string,
  settings: ProviderSettings,
  signal?: AbortSignal,
): Promise<string> {
  // Inline instructions instead of using the system role — keeps us provider-
  // agnostic. The blank-line separators help every model we tested treat the
  // selection as data, not as commands.
  const query = [
    PROOFREAD_SYSTEM_PROMPT,
    "",
    "TEXT TO PROOFREAD:",
    selection,
  ].join("\n");

  // Override webSearch / imageGeneration — neither makes sense here, and
  // having them on can derail short proofreads on some providers.
  const result = await askProvider({
    query,
    settings: { ...settings, webSearch: false, imageGeneration: false },
    signal,
  });

  // Belt-and-braces em-dash strip: even instructed models occasionally slip
  // one in. Comma + space is close to what most em-dashes meant.
  let cleaned = result.text.replace(/\u2014/g, ", ").trim();
  // Some models echo the instructions or the "TEXT TO PROOFREAD:" marker.
  // Trim that off if it slipped through.
  cleaned = cleaned.replace(/^(TEXT TO PROOFREAD:?\s*)/i, "").trim();
  // Strip surrounding quotes a model might add around the result.
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

type LegacySettings = Partial<ProviderSettings> & {
  provider?: "mock" | "codex" | "openai" | "ollama";
  openaiModel?: string;
  ollamaModel?: string;
  ollamaUrl?: string; // old field, no longer used
};

export function normalizeSettings(input: LegacySettings): ProviderSettings {
  const providerModel = input.providerModel ?? legacyProviderModel(input);
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    providerModel: isKnownModel(providerModel) || isDynamicOllamaProviderModel(providerModel)
      ? providerModel
      : DEFAULT_SETTINGS.providerModel,
    hotkey: normalizeHotkey(input.hotkey),
    proofreadHotkey: normalizeOptionalHotkey(input.proofreadHotkey),
  };
}

function normalizeOptionalHotkey(input: HotkeySpec | null | undefined): HotkeySpec | null {
  if (input === null || input === undefined) return null;
  // If the persisted spec is corrupt, fall back to "off" rather than the
  // default — proofread is opt-in, we don't want to silently enable it.
  if (typeof input !== "object") return null;
  if (input.kind === "double-tap" && VALID_MODIFIERS.has(input.key)) {
    return { kind: "double-tap", key: input.key };
  }
  if (input.kind === "combo" && Array.isArray(input.modifiers) && typeof input.code === "string") {
    const modifiers = input.modifiers.filter((m): m is ModifierKey => VALID_MODIFIERS.has(m));
    if (modifiers.length > 0 && input.code.length > 0) {
      return { kind: "combo", modifiers, code: input.code };
    }
  }
  return null;
}

const VALID_MODIFIERS = new Set<ModifierKey>(["alt", "cmd", "ctrl", "shift"]);

function normalizeHotkey(input: HotkeySpec | undefined): HotkeySpec {
  if (!input || typeof input !== "object") return DEFAULT_HOTKEY;
  if (input.kind === "double-tap" && VALID_MODIFIERS.has(input.key)) {
    return { kind: "double-tap", key: input.key };
  }
  if (input.kind === "combo" && Array.isArray(input.modifiers) && typeof input.code === "string") {
    const modifiers = input.modifiers.filter((m): m is ModifierKey => VALID_MODIFIERS.has(m));
    if (modifiers.length > 0 && input.code.length > 0) {
      return { kind: "combo", modifiers, code: input.code };
    }
  }
  return DEFAULT_HOTKEY;
}

const MODIFIER_SYMBOLS: Record<ModifierKey, string> = {
  alt: "⌥",
  cmd: "⌘",
  ctrl: "⌃",
  shift: "⇧",
};

const MODIFIER_NAMES: Record<ModifierKey, string> = {
  alt: "Option",
  cmd: "Command",
  ctrl: "Control",
  shift: "Shift",
};

const MODIFIER_ORDER: ModifierKey[] = ["ctrl", "alt", "shift", "cmd"];

export function describeHotkey(spec: HotkeySpec): string {
  if (spec.kind === "double-tap") {
    return `Double ${MODIFIER_SYMBOLS[spec.key]} ${MODIFIER_NAMES[spec.key]}`;
  }
  const sortedMods = MODIFIER_ORDER.filter((m) => spec.modifiers.includes(m));
  const mods = sortedMods.map((m) => MODIFIER_SYMBOLS[m]).join("");
  return `${mods} ${formatKeyCode(spec.code)}`;
}

function formatKeyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}

export function getModelOption(providerModel: string): ModelOption {
  const known = MODEL_OPTIONS.find((option) => option.id === providerModel);
  if (known) return known;

  if (isDynamicOllamaProviderModel(providerModel)) {
    const model = providerModel.slice("local/".length);
    return {
      id: providerModel,
      label: model,
      provider: "local",
      providerLabel: "Ollama",
      group: "Installed Ollama",
    };
  }

  return MODEL_OPTIONS[0];
}

export function groupedModelOptions(extraOptions: ModelOption[] = [], baseOptions = MODEL_OPTIONS) {
  const groups = new Map<string, ModelOption[]>();
  for (const option of [...baseOptions, ...extraOptions]) {
    if (groups.get(option.group)?.some((existing) => existing.id === option.id)) continue;
    groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  }
  return [...groups.entries()];
}

export async function askProvider({
  query,
  settings,
  signal,
  history = [],
  images = [],
}: AskOptions): Promise<AiResult> {
  const trimmed = query.trim();
  if (!trimmed && images.length === 0) {
    return {
      text: "Ask something first.",
      providerLabel: "Local",
      modelLabel: "Idle",
    };
  }

  const resolved = resolveProviderModel(settings.providerModel);
  switch (resolved.provider) {
    case "openai":
      return askOpenAI(trimmed, settings, resolved.model, history, images, signal);
    case "local":
      return askLocal(trimmed, settings, resolved.model, history, images);
    case "openai-codex":
      return askCodexSubscription(
        trimmed,
        resolved.model,
        settings.webSearch,
        history,
        settings.imageGeneration,
        images,
      );
    case "zai":
    case "zai-coding":
    case "openrouter":
    case "deepseek":
    case "google":
    case "groq":
    case "mistral":
      return askOpenAICompat(trimmed, settings, resolved.provider, resolved.model, history, images, signal);
    case "mock":
    default:
      return askMock(trimmed, settings.webSearch, history);
  }
}

function resolveProviderModel(providerModel: string): { provider: ProviderKind; model: string } {
  const separator = providerModel.indexOf("/");
  if (separator < 1) return { provider: "mock", model: "preview" };

  const provider = providerModel.slice(0, separator) as ProviderKind;
  const model = providerModel.slice(separator + 1);

  if (!ALL_PROVIDER_KINDS.includes(provider)) {
    return { provider: "mock", model: "preview" };
  }
  return { provider, model };
}

async function askOpenAI(
  query: string,
  settings: ProviderSettings,
  model: string,
  history: ConversationTurn[],
  images: ImageAttachment[],
  signal?: AbortSignal,
): Promise<AiResult> {
  if (!settings.openaiApiKey.trim()) {
    return {
      text: "Add an OpenAI API key in settings, or switch to ChatGPT / local.",
      providerLabel: "OpenAI API",
      modelLabel: model,
    };
  }

  if (settings.imageGeneration && images.length === 0) {
    return askOpenAIImageGeneration(query, settings, signal);
  }

  // Public Responses API uses `web_search_preview` (the ChatGPT-backend
  // endpoint uses bare `web_search` instead — branched per-provider).
  const tools: Array<Record<string, unknown>> = [];
  if (settings.webSearch) tools.push({ type: "web_search_preview" });
  if (settings.imageGeneration) tools.push({ type: "image_generation" });

  const userContent: Array<Record<string, unknown>> = [
    { type: "input_text", text: query || "Describe the attached image." },
    ...images.map((image) => ({
      type: "input_image",
      image_url: image.dataUrl,
    })),
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: DIRECT_SYSTEM_PROMPT },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: userContent },
      ],
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      include: settings.webSearch ? ["web_search_call.action.sources"] : undefined,
    }),
  });

  if (!response.ok) {
    const message = await readError(response);
    return {
      text: message,
      providerLabel: "OpenAI API",
      modelLabel: model,
    };
  }

  const data = await response.json();
  return {
    text: extractOpenAIText(data),
    sources: extractOpenAISources(data),
    images: extractOpenAIImages(data),
    providerLabel: "OpenAI API",
    modelLabel: model,
  };
}

/**
 * Generic OpenAI-compatible chat completions caller.
 *
 * All listed providers (z.ai/GLM, OpenRouter, DeepSeek, Google, Groq, Mistral)
 * speak the standard `/chat/completions` schema, so we share one path.
 * Z.ai is the lone exception — it accepts a non-standard `thinking` toggle
 * instead of OpenAI's `reasoning_effort`. Anything else just ignores it.
 */
async function askOpenAICompat(
  query: string,
  settings: ProviderSettings,
  provider: ProviderKind,
  model: string,
  history: ConversationTurn[],
  images: ImageAttachment[],
  signal?: AbortSignal,
): Promise<AiResult> {
  const config = OPENAI_COMPAT_CONFIG[provider];
  if (!config) {
    return { text: `Unknown provider: ${provider}`, providerLabel: provider, modelLabel: model };
  }

  const apiKey = String(settings[config.apiKeyField] ?? "").trim();
  if (!apiKey) {
    return {
      text: `Add a ${config.providerLabel} API key in settings, or pick another model.`,
      providerLabel: config.providerLabel,
      modelLabel: model,
    };
  }

  const userContent: Array<Record<string, unknown>> | string = images.length
    ? [
        { type: "text", text: query || "Describe the attached image." },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ]
    : query;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: DIRECT_SYSTEM_PROMPT },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: userContent },
    ],
    temperature: 0.7,
  };

  if (config.zaiThinking) {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readError(response);
    return { text: message, providerLabel: config.providerLabel, modelLabel: model };
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text =
    typeof data.choices?.[0]?.message?.content === "string"
      ? (data.choices[0].message!.content as string).trim()
      : "";

  return {
    text: text || "No response.",
    providerLabel: config.providerLabel,
    modelLabel: model,
  };
}

async function askOpenAIImageGeneration(
  query: string,
  settings: ProviderSettings,
  signal?: AbortSignal,
): Promise<AiResult> {
  const prompt = query.trim();
  if (!prompt) {
    return {
      text: "Describe the image you want to generate.",
      providerLabel: "OpenAI API",
      modelLabel: GPT_IMAGE_MODEL,
    };
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey.trim()}`,
    },
    body: JSON.stringify({
      model: GPT_IMAGE_MODEL,
      prompt,
    }),
  });

  if (!response.ok) {
    const message = await readError(response);
    return {
      text: message,
      providerLabel: "OpenAI API",
      modelLabel: GPT_IMAGE_MODEL,
    };
  }

  const data = await response.json();
  const generated = extractImageApiImages(data);
  return {
    text: generated.length ? `Generated with ${GPT_IMAGE_MODEL}.` : "No image returned.",
    images: generated,
    providerLabel: "OpenAI API",
    modelLabel: GPT_IMAGE_MODEL,
  };
}

async function askLocal(
  query: string,
  settings: ProviderSettings,
  model: string,
  history: ConversationTurn[],
  images: ImageAttachment[],
): Promise<AiResult> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      text: "Local models run in the native KEN app. The browser preview can't call llama.cpp.",
      providerLabel: "Local",
      modelLabel: model,
    };
  }

  if (isOllamaModel(model)) {
    return askOllama(query, settings, model, history, images);
  }

  if (images.length > 0) {
    return {
      text: "Image input needs an Ollama vision model such as Gemma 3 4B Vision or Qwen 2.5 VL.",
      providerLabel: "Local",
      modelLabel: model,
    };
  }

  try {
    const response = await invoke<{ text: string; source: string }>("ask_local_model", {
      request: { prompt: query, model, history },
    });
    const providerLabel = response.source ? `Local (shared from ${response.source})` : "Local";
    return {
      text: response.text || "No response.",
      providerLabel,
      modelLabel: model,
    };
  } catch (caught) {
    return {
      text: String(caught),
      providerLabel: "Local",
      modelLabel: model,
    };
  }
}

async function askOllama(
  query: string,
  settings: ProviderSettings,
  model: string,
  history: ConversationTurn[],
  images: ImageAttachment[],
): Promise<AiResult> {
  let sources: Source[] = [];
  let searchContext = "";

  if (settings.webSearch) {
    const search = await runLocalSearch(query || imageSearchFallback(images), settings);
    sources = search.sources;
    searchContext = search.context;
  }

  try {
    const response = await invoke<{ text: string }>("ask_ollama_model", {
      request: {
        baseUrl: settings.ollamaUrl,
        prompt: query,
        model,
        history,
        images: images.map((image) => ({ base64: image.base64 })),
        searchContext,
      },
    });
    return {
      text: response.text || "No response.",
      sources,
      providerLabel: "Ollama",
      modelLabel: model,
    };
  } catch (caught) {
    return {
      text: String(caught),
      sources,
      providerLabel: "Ollama",
      modelLabel: model,
    };
  }
}

async function askCodexSubscription(
  query: string,
  model: string,
  webSearch: boolean,
  history: ConversationTurn[],
  imageGeneration: boolean,
  images: ImageAttachment[],
): Promise<AiResult> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const response = await invoke<{ text: string; images: string[] }>("ask_codex_subscription", {
        request: {
          prompt: query,
          model,
          webSearch,
          imageGeneration,
          history,
          images: images.map((image) => ({
            name: image.name,
            mimeType: image.mimeType,
            dataUrl: image.dataUrl,
          })),
        },
      });

      return {
        text: response.text,
        images: response.images,
        providerLabel: "ChatGPT",
        modelLabel: model,
      };
    } catch (caught) {
      return {
        text: typeof caught === "string" ? caught : (caught as Error)?.message || String(caught),
        providerLabel: "ChatGPT",
        modelLabel: model,
      };
    }
  }

  return {
    text: [
      "ChatGPT subscription works in the native KEN app.",
      "The browser preview cannot read Codex OAuth tokens or call the native Tauri command.",
      "Open KEN.app and ask again.",
    ].join("\n"),
    providerLabel: "ChatGPT",
    modelLabel: model,
  };
}

async function askMock(
  query: string,
  webSearch: boolean,
  history: ConversationTurn[],
): Promise<AiResult> {
  await new Promise((resolve) => window.setTimeout(resolve, 180));
  return {
    text: [
      `Preview answer for: ${query}`,
      history.length ? `Follow-up with ${history.length} prior turn(s).` : null,
      webSearch ? "Web mode is on; OpenAI API can attach live search." : "Pick a live model for real AI.",
    ]
      .filter(Boolean)
      .join("\n"),
    providerLabel: "Mock",
    modelLabel: "preview",
  };
}

async function readError(response: Response) {
  try {
    const data = await response.json();
    return data?.error?.message || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function legacyProviderModel(input: LegacySettings): string {
  if (input.provider === "openai") return `openai/${input.openaiModel || "gpt-5.4"}`;
  if (input.provider === "ollama") return `local/${input.ollamaModel || "gemma3:4b"}`;
  if (input.provider === "codex") return "openai-codex/gpt-5.4";
  if (input.provider === "mock") return "mock/preview";
  return DEFAULT_SETTINGS.providerModel;
}

function isOllamaModel(model: string) {
  return model.includes(":");
}

function imageSearchFallback(images: ImageAttachment[]) {
  return images.length ? "OCR or describe the attached image" : "";
}

async function runLocalSearch(
  query: string,
  settings: ProviderSettings,
): Promise<{ sources: Source[]; context: string }> {
  const apiKey =
    settings.searchProvider === "brave" ? settings.braveApiKey : settings.tavilyApiKey;
  const response = await invoke<{ results: Array<{ title: string; url: string; content: string }> }>(
    "search_web",
    {
      request: {
        provider: settings.searchProvider,
        query,
        apiKey,
      },
    },
  );

  const results = response.results ?? [];
  const sources = uniqueSources(
    results.map((result) => ({
      title: result.title || result.url,
      url: result.url,
    })),
  );
  const context = results
    .map((result, index) => {
      const title = result.title || result.url;
      const content = result.content || "";
      return `[${index + 1}] ${title}\n${result.url}\n${content}`;
    })
    .join("\n\n");

  return { sources, context };
}

function isKnownModel(providerModel: string) {
  return MODEL_OPTIONS.some((option) => option.id === providerModel);
}

function isDynamicOllamaProviderModel(providerModel: string) {
  if (!providerModel.startsWith("local/")) return false;
  const model = providerModel.slice("local/".length);
  return Boolean(model) && model.includes(":");
}

function extractOpenAIText(data: unknown): string {
  if (typeof data === "object" && data !== null && "output_text" in data) {
    const text = (data as { output_text?: unknown }).output_text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }

  const output = (data as { output?: Array<unknown> })?.output;
  const pieces =
    output?.flatMap((item) => {
      const content = (item as { content?: Array<unknown> })?.content;
      return (
        content
          ?.map((part) => (part as { text?: unknown })?.text)
          .filter((text): text is string => typeof text === "string") ?? []
      );
    }) ?? [];

  return pieces.join("\n").trim() || "No response.";
}

function extractOpenAISources(data: unknown): Source[] {
  const output = (data as { output?: Array<unknown> })?.output ?? [];
  const sources: Source[] = [];

  for (const item of output) {
    const content = (item as { content?: Array<unknown> })?.content ?? [];
    for (const part of content) {
      const annotations = (part as { annotations?: Array<unknown> })?.annotations ?? [];
      for (const annotation of annotations) {
        const maybe = annotation as { type?: string; title?: string; url?: string };
        if (maybe.type === "url_citation" && maybe.url) {
          sources.push({
            title: maybe.title || maybe.url,
            url: maybe.url,
          });
        }
      }
    }
  }

  return uniqueSources(sources).slice(0, 4);
}

function extractOpenAIImages(data: unknown): string[] {
  const output = (data as { output?: Array<unknown> })?.output ?? [];
  const images: string[] = [];
  for (const item of output) {
    const maybe = item as { type?: string; result?: unknown };
    if (maybe.type === "image_generation_call" && typeof maybe.result === "string" && maybe.result.length > 100) {
      images.push(maybe.result);
    }
  }
  return images;
}

function extractImageApiImages(data: unknown): string[] {
  const items = (data as { data?: Array<unknown> })?.data ?? [];
  return items
    .map((item) => (item as { b64_json?: unknown })?.b64_json)
    .filter((image): image is string => typeof image === "string" && image.length > 100);
}

function uniqueSources(sources: Source[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}
