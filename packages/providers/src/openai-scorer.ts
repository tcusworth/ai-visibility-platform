export interface ScorerRequest {
  prompt: string;
}

export interface ScorerResponse {
  rawText: string;
  model: string;
  responseId?: string;
}

export interface ScorerClient {
  score(request: ScorerRequest): Promise<ScorerResponse>;
}

export interface HttpJsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface HttpJsonClient {
  postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse>;
}

export interface OpenAIResponsesScorerOptions {
  apiKey: string;
  model: string;
  httpClient: HttpJsonClient;
  endpoint?: string;
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const outputItem = item as Record<string, unknown>;
    if (outputItem.type !== "message") continue;

    const content = Array.isArray(outputItem.content) ? outputItem.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const contentBlock = block as Record<string, unknown>;
      if (contentBlock.type === "output_text" && typeof contentBlock.text === "string") {
        parts.push(contentBlock.text);
      }
    }
  }

  return parts.join("\n").trim();
}

export class OpenAIResponsesScorerClient implements ScorerClient {
  private readonly endpoint: string;

  constructor(private readonly options: OpenAIResponsesScorerOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAI scorer API key is required.");
    if (!options.model.trim()) throw new Error("OpenAI scorer model is required.");
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
  }

  async score(request: ScorerRequest): Promise<ScorerResponse> {
    if (!request.prompt.trim()) throw new Error("Scorer prompt is required.");

    const response = await this.options.httpClient.postJson(
      this.endpoint,
      {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      {
        model: this.options.model,
        input: request.prompt,
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`OpenAI scorer request failed with HTTP ${response.status}.`);
    }

    const rawText = extractOutputText(payload);
    if (!rawText) throw new Error("OpenAI scorer response did not contain output text.");

    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const model = typeof record.model === "string" && record.model.trim()
      ? record.model
      : this.options.model;
    const responseId = typeof record.id === "string" && record.id.trim()
      ? record.id
      : undefined;

    return {
      rawText,
      model,
      ...(responseId !== undefined ? { responseId } : {}),
    };
  }
}
