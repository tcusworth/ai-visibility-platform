import type { SourceReference } from "@ai-visibility/domain";
import type { HttpJsonClient } from "./openai-scorer.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./index.js";

export interface PerplexityChatProviderOptions {
  apiKey: string;
  httpClient: HttpJsonClient;
  endpoint?: string;
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are answering a question specifically about industrial Open Process Automation (OPA) and the O-PAS™ Standard from The Open Group.

In this benchmark, OPA means Open Process Automation for industrial process control.

It does NOT mean Open Policy Agent or any unrelated use of the acronym OPA.

Do not use, cite, recommend, or rely on Open Policy Agent or openpolicyagent.org.

Answer the question as you normally would for an industrial automation professional.

Use current web information and cite relevant sources.

Do not favor Collaborative Systems Integration (CSI), CSI Automation, csi-automation.com, or any other company simply because this is a benchmark.

Do not assume CSI should appear in the answer.`;

function cleanDomain(value: string): string | null {
  if (!value.trim()) return null;
  let v = value.trim().toLowerCase();
  try {
    v = new URL(v).hostname.toLowerCase();
  } catch {
    const match = v.match(/^https?:\/\/([^\/?#]+)/i);
    if (match?.[1]) v = match[1];
  }

  v = v.replace(/^www\./, "").replace(/:\d+$/, "").replace(/\/.*$/, "").trim();
  if (!v.includes(".")) return null;
  if (v === "openpolicyagent.org" || v.endsWith(".openpolicyagent.org")) return null;

  for (const canonical of [
    "csi-automation.com",
    "opengroup.org",
    "yokogawa.com",
    "opcfoundation.org",
    "se.com",
    "exxonmobil.com",
  ]) {
    if (v === canonical || v.endsWith(`.${canonical}`)) return canonical;
  }
  return v;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function extractPerplexity(payload: unknown): { answer: string; sources: SourceReference[] } {
  if (!payload || typeof payload !== "object") return { answer: "", sources: [] };
  const response = payload as Record<string, unknown>;
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice = choices[0];
  let answer = "";
  if (firstChoice && typeof firstChoice === "object") {
    const message = (firstChoice as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") answer = content.trim();
    }
  }

  const citedUrls = [...new Set(stringArray(response.citations))];
  const searchResults = Array.isArray(response.search_results) ? response.search_results : [];
  const byUrl = new Map<string, SourceReference>();

  for (const value of searchResults) {
    if (!value || typeof value !== "object") continue;
    const result = value as Record<string, unknown>;
    const urlValue = typeof result.url === "string" ? result.url : typeof result.link === "string" ? result.link : "";
    const url = urlValue.trim();
    if (!url) continue;
    const domain = cleanDomain(url);
    if (!domain) continue;
    byUrl.set(url, { url, domain, ownedByTarget: false });
  }

  for (const url of citedUrls) {
    if (byUrl.has(url)) continue;
    const domain = cleanDomain(url);
    if (!domain) continue;
    byUrl.set(url, { url, domain, ownedByTarget: false });
  }

  return { answer, sources: [...byUrl.values()] };
}

function extractErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown Perplexity API error";
  const record = payload as Record<string, unknown>;
  const errorValue = record.error;
  if (typeof errorValue === "string" && errorValue.trim()) return errorValue.trim();
  if (errorValue && typeof errorValue === "object") {
    const error = errorValue as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const type = typeof error.type === "string" ? error.type.trim() : "";
    const code = typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : "";
    const parts = [code, type, message].filter(Boolean);
    if (parts.length > 0) return parts.join(": ");
  }
  try {
    return JSON.stringify(payload).slice(0, 1000);
  } catch {
    return "unreadable Perplexity API error payload";
  }
}

export class PerplexityChatProvider implements ModelProvider {
  readonly platform = "perplexity" as const;
  private readonly endpoint: string;
  private readonly systemPrompt: string;

  constructor(private readonly options: PerplexityChatProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Perplexity provider API key is required.");
    this.endpoint = options.endpoint ?? "https://api.perplexity.ai/chat/completions";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.platform !== this.platform) {
      throw new Error(`Perplexity provider cannot execute platform ${String(request.platform)}.`);
    }
    if (!request.model.trim()) throw new Error("Perplexity provider model is required.");
    if (!request.prompt.trim()) throw new Error("Perplexity provider prompt is required.");

    const response = await this.options.httpClient.postJson(
      this.endpoint,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      {
        model: request.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: request.prompt },
        ],
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Perplexity provider request failed with HTTP ${response.status}: ${extractErrorDetail(payload)}`);
    }

    const extracted = extractPerplexity(payload);
    if (!extracted.answer) throw new Error("Perplexity provider response did not contain answer text.");
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
