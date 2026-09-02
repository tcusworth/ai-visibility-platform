import type { SourceReference } from "@ai-visibility/domain";
import type { HttpJsonClient } from "./openai-scorer.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./index.js";

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  httpClient: HttpJsonClient;
  endpoint?: string;
  webSearch?: boolean;
}

function normalizeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  } catch {
    return null;
  }
}

function extractAnswer(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== "message") continue;
    const content = Array.isArray(candidate.content) ? candidate.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const contentBlock = block as Record<string, unknown>;
      if (contentBlock.type === "output_text" && typeof contentBlock.text === "string") {
        parts.push(contentBlock.text);
      }
    }
  }
  return parts.join("\n\n").trim();
}

function collectUrls(value: unknown, urls: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.trim()) urls.add(record.url.trim());
  }
}

function extractSources(payload: unknown): SourceReference[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const urls = new Set<string>();

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;

    if (candidate.type === "message") {
      const content = Array.isArray(candidate.content) ? candidate.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const contentBlock = block as Record<string, unknown>;
        collectUrls(contentBlock.annotations, urls);
      }
    }

    if (candidate.type === "web_search_call") {
      collectUrls(candidate.results, urls);
      collectUrls(candidate.search_results, urls);
      if (candidate.action && typeof candidate.action === "object") {
        collectUrls((candidate.action as Record<string, unknown>).sources, urls);
      }
    }
  }

  return [...urls].flatMap((url) => {
    const domain = normalizeDomain(url);
    if (!domain) return [];
    return [{ url, domain, ownedByTarget: false }];
  });
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly platform = "openai" as const;
  private readonly endpoint: string;
  private readonly webSearch: boolean;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAI provider API key is required.");
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.webSearch = options.webSearch ?? true;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.platform !== this.platform) {
      throw new Error(`OpenAI provider cannot execute platform ${String(request.platform)}.`);
    }
    if (!request.model.trim()) throw new Error("OpenAI provider model is required.");
    if (!request.prompt.trim()) throw new Error("OpenAI provider prompt is required.");

    const response = await this.options.httpClient.postJson(
      this.endpoint,
      {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      {
        model: request.model,
        ...(this.webSearch ? { tools: [{ type: "web_search" }] } : {}),
        input: request.prompt,
      },
    );

    const payload = await response.json();
    if (!response.ok) throw new Error(`OpenAI provider request failed with HTTP ${response.status}.`);

    const answer = extractAnswer(payload);
    if (!answer) throw new Error("OpenAI provider response did not contain answer text.");

    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const model = typeof record.model === "string" && record.model.trim() ? record.model : request.model;
    const responseId = typeof record.id === "string" && record.id.trim() ? record.id : undefined;
    const sources = extractSources(payload);

    return {
      answer,
      model,
      ...(responseId !== undefined ? { rawProviderId: responseId } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    };
  }
}
