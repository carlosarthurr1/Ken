import { invoke } from "@tauri-apps/api/core";

export type ProviderKind = "mock" | "openai-codex" | "openai" | "local";

export type ModelOption = {
  id: string;
  label: string;
  provider: ProviderKind;
  providerLabel: string;
  group: string;
};

export type ProviderSettings = {
  providerModel: string;
  openaiApiKey: string;
  webSearch: boolean;
  imageGeneration: boolean;
  ollamaUrl: string;
  searchProvider: "tavily" | "brave";
  tavilyApiKey: string;
  braveApiKey: string;
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

export const DEFAULT_SETTINGS: ProviderSettings = {
  providerModel: "openai-codex/gpt-5.5",
  openaiApiKey: "",
  webSearch: false,
  imageGeneration: false,
  ollamaUrl: "http://localhost:11434",
  searchProvider: "tavily",
  tavilyApiKey: "",
  braveApiKey: "",
};

const DIRECT_SYSTEM_PROMPT =
  "Answer directly. Keep it under 90 words unless the user asks for depth. Prefer short bullets. No preamble.";
const GPT_IMAGE_MODEL = "gpt-image-2";

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
  };
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

  if (!["mock", "openai-codex", "openai", "local"].includes(provider)) {
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
