import type { HttpJsonClient, HttpJsonResponse } from "@ai-visibility/providers";
import { CSI_PROVIDER_MODELS, createCsiProviderRegistry } from "./csi-provider-registry.js";

class NoNetworkHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(_url: string, _headers: Record<string, string>, _body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    throw new Error("Offline provider-registry validation must not make HTTP requests.");
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
}

const httpClient = new NoNetworkHttpClient();
const registry = createCsiProviderRegistry(
  {
    openaiApiKey: "offline-openai-key",
    geminiApiKey: "offline-gemini-key",
    perplexityApiKey: "offline-perplexity-key",
    anthropicApiKey: "offline-anthropic-key",
  },
  httpClient,
);

assert(registry.get("openai").platform === "openai", "OpenAI registered");
assert(registry.get("gemini").platform === "gemini", "Gemini registered");
assert(registry.get("perplexity").platform === "perplexity", "Perplexity registered");
assert(registry.get("claude").platform === "claude", "Claude registered");

assert(CSI_PROVIDER_MODELS.openai === "gpt-5.6-luna", "OpenAI model configuration preserved");
assert(CSI_PROVIDER_MODELS.gemini === "gemini-3.7-flash", "Gemini model configuration preserved");
assert(CSI_PROVIDER_MODELS.perplexity === "sonar", "Perplexity model configuration preserved");
assert(CSI_PROVIDER_MODELS.claude === "claude-sonnet-4-6", "Claude model configuration preserved");
assert(httpClient.calls === 0, "No HTTP requests were made");

console.log("Four-provider CSI shadow registry validation passed.");
console.log("Claude is now wired into the same provider registry as OpenAI, Gemini, and Perplexity.");
console.log("No provider API calls, scorer calls, database writes, n8n calls, Google Sheets writes, or CSI production changes were made.");
