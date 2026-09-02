import type { SourceReference } from "@ai-visibility/domain";
import type { HttpJsonClient } from "./openai-scorer.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./index.js";

export interface GeminiInteractionsProviderOptions {
  apiKey: string;
  httpClient: HttpJsonClient;
  endpoint?: string;
  googleSearch?: boolean;
}

function cleanDomain(value: string): string | null {
  let v = value.trim().toLowerCase();
  try {
    v = new URL(v).hostname.toLowerCase();
  } catch {
    v = v.replace(/^www\./, "").replace(/:\d+$/, "").replace(/\/.*$/, "");
  }
  v = v.replace(/^www\./, "").replace(/:\d+$/, "");
  if (!v.includes(".")) return null;
  if (v === "vertexaisearch.cloud.google.com" || v.endsWith(".vertexaisearch.cloud.google.com")) return null;
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

function extractGemini(payload: unknown): { answer: string; sources: SourceReference[] } {
  if (!payload || typeof payload !== "object") return { answer: "", sources: [] };
  const response = payload as Record<string, unknown>;
  const steps = Array.isArray(response.steps) ? response.steps : [];
  const answerParts: string[] = [];
  const cited = new Map<string, string>();

  for (const stepValue of steps) {
    if (!stepValue || typeof stepValue !== "object") continue;
    const step = stepValue as Record<string, unknown>;
    if (step.type !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const partValue of content) {
      if (!partValue || typeof partValue !== "object") continue;
      const part = partValue as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) answerParts.push(part.text);
      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotationValue of annotations) {
        if (!annotationValue || typeof annotationValue !== "object") continue;
        const annotation = annotationValue as Record<string, unknown>;
        if (annotation.type !== "url_citation" || typeof annotation.url !== "string" || !annotation.url.trim()) continue;
        cited.set(annotation.url.trim(), typeof annotation.title === "string" ? annotation.title.trim() : "");
      }
    }
  }

  const fallback = typeof response.output_text === "string" ? response.output_text.trim() : "";
  const answer = answerParts.join("\n\n").trim() || fallback;
  const sources: SourceReference[] = [];
  for (const [url, title] of cited) {
    const domain = cleanDomain(url) ?? cleanDomain(title);
    if (!domain) continue;
    sources.push({ url, domain, ownedByTarget: false });
  }
  return { answer, sources };
}

function extractErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown Gemini API error";
  const record = payload as Record<string, unknown>;
  const errorValue = record.error;
  if (errorValue && typeof errorValue === "object") {
    const errorRecord = errorValue as Record<string, unknown>;
    const parts = [
      typeof errorRecord.status === "string" ? errorRecord.status : "",
      typeof errorRecord.message === "string" ? errorRecord.message : "",
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(": ");
  }
  try {
    return JSON.stringify(payload).slice(0, 1000);
  } catch {
    return "unreadable Gemini API error payload";
  }
}

export class GeminiInteractionsProvider implements ModelProvider {
  readonly platform = "gemini" as const;
  private readonly endpoint: string;
  private readonly googleSearch: boolean;

  constructor(private readonly options: GeminiInteractionsProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Gemini provider API key is required.");
    this.endpoint = options.endpoint ?? "https://generativelanguage.googleapis.com/v1beta/interactions";
    this.googleSearch = options.googleSearch ?? true;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.platform !== this.platform) throw new Error(`Gemini provider cannot execute platform ${String(request.platform)}.`);
    if (!request.model.trim()) throw new Error("Gemini provider model is required.");
    if (!request.prompt.trim()) throw new Error("Gemini provider prompt is required.");

    const response = await this.options.httpClient.postJson(
      this.endpoint,
      {
        "Content-Type": "application/json",
        "x-goog-api-key": this.options.apiKey,
        model: request.model,
      },
      {
        model: request.model,
        input: request.prompt,
        ...(this.googleSearch ? { tools: [{ type: "google_search" }] } : {}),
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Gemini provider request failed with HTTP ${response.status}: ${extractErrorDetail(payload)}`);
    }

    const extracted = extractGemini(payload);
    if (!extracted.answer) throw new Error("Gemini provider response did not contain answer text.");
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const model = typeof record.model === "string" && record.model.trim() ? record.model : request.model;
    const responseId = typeof record.id === "string" && record.id.trim() ? record.id : undefined;

    return {
      answer: extracted.answer,
      model,
      ...(responseId !== undefined ? { rawProviderId: responseId } : {}),
      ...(extracted.sources.length > 0 ? { sources: extracted.sources } : {}),
    };
  }
}
