import type { SourceReference } from "@ai-visibility/domain";
import type { HttpJsonClient } from "./openai-scorer.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./index.js";

export interface ClaudeMessagesProviderOptions {
  apiKey: string;
  httpClient: HttpJsonClient;
  endpoint?: string;
  anthropicVersion?: string;
  maxTokens?: number;
  webSearchMaxUses?: number;
}

function normalizeDomain(url: string): string | null {
  if (!url.trim()) return null;

  const match = url.trim().match(/^https?:\/\/([^\/?#]+)/i);
  if (!match?.[1]) return null;

  const domain = match[1]
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/:\d+$/, "");

  if (domain === "openpolicyagent.org" || domain.endsWith(".openpolicyagent.org")) return null;

  for (const canonical of [
    "csi-automation.com",
    "opengroup.org",
    "yokogawa.com",
    "opcfoundation.org",
    "se.com",
    "exxonmobil.com",
  ]) {
    if (domain === canonical || domain.endsWith(`.${canonical}`)) return canonical;
  }

  return domain;
}

function extractClaude(payload: unknown): { answer: string; sources: SourceReference[] } {
  if (!payload || typeof payload !== "object") return { answer: "", sources: [] };
  const response = payload as Record<string, unknown>;
  const content = Array.isArray(response.content) ? response.content : [];
  const answerParts: string[] = [];
  const rawSources = new Set<string>();

  for (const blockValue of content) {
    if (!blockValue || typeof blockValue !== "object") continue;
    const block = blockValue as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      answerParts.push(block.text.trim());
    }

    if (block.type === "web_search_tool_result") {
      const results = Array.isArray(block.content) ? block.content : [];
      for (const resultValue of results) {
        if (!resultValue || typeof resultValue !== "object") continue;
        const result = resultValue as Record<string, unknown>;
        if (result.type === "web_search_result" && typeof result.url === "string" && result.url.trim()) {
          rawSources.add(result.url.trim());
        }
      }
    }
  }

  const sources: SourceReference[] = [];
  for (const url of rawSources) {
    const domain = normalizeDomain(url);
    if (!domain) continue;
    sources.push({ url, domain, ownedByTarget: false });
  }

  return {
    answer: answerParts.join("\n\n").trim(),
    sources,
  };
}

function extractErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown Anthropic API error";
  const record = payload as Record<string, unknown>;
  const errorValue = record.error;
  if (typeof errorValue === "string" && errorValue.trim()) return errorValue.trim();
  if (errorValue && typeof errorValue === "object") {
    const error = errorValue as Record<string, unknown>;
    const type = typeof error.type === "string" ? error.type.trim() : "";
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const parts = [type, message].filter(Boolean);
    if (parts.length > 0) return parts.join(": ");
  }
  try {
    return JSON.stringify(payload).slice(0, 1000);
  } catch {
    return "unreadable Anthropic API error payload";
  }
}

export class ClaudeMessagesProvider implements ModelProvider {
  readonly platform = "claude" as const;
  private readonly endpoint: string;
  private readonly anthropicVersion: string;
  private readonly maxTokens: number;
  private readonly webSearchMaxUses: number;

  constructor(private readonly options: ClaudeMessagesProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Claude provider API key is required.");
    this.endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
    this.maxTokens = options.maxTokens ?? 900;
    this.webSearchMaxUses = options.webSearchMaxUses ?? 2;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.platform !== this.platform) {
      throw new Error(`Claude provider cannot execute platform ${String(request.platform)}.`);
    }
    if (!request.model.trim()) throw new Error("Claude provider model is required.");
    if (!request.prompt.trim()) throw new Error("Claude provider prompt is required.");

    const response = await this.options.httpClient.postJson(
      this.endpoint,
      {
        "Content-Type": "application/json",
        "anthropic-version": this.anthropicVersion,
        "x-api-key": this.options.apiKey,
      },
      {
        model: request.model,
        max_tokens: this.maxTokens,
        tools: [
          {
            type: "web_search_20260209",
            name: "web_search",
            allowed_callers: ["direct"],
            max_uses: this.webSearchMaxUses,
          },
        ],
        messages: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Claude provider request failed with HTTP ${response.status}: ${extractErrorDetail(payload)}`);
    }

    const extracted = extractClaude(payload);
    if (!extracted.answer) throw new Error("Claude provider response did not contain answer text.");
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : request.model;
    const responseId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;

    return {
      answer: extracted.answer,
      model,
      ...(responseId !== undefined ? { rawProviderId: responseId } : {}),
      ...(extracted.sources.length > 0 ? { sources: extracted.sources } : {}),
    };
  }
}
