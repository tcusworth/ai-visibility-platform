import {
  PerplexityChatProvider,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";

class CountingFetchHttpJsonClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > 1) throw new Error("Live Perplexity provider validator attempted more than one HTTP request.");

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json() as Promise<unknown>,
    };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.env.ALLOW_LIVE_PERPLEXITY_PROVIDER !== "YES") {
  throw new Error(
    "Live Perplexity benchmark-provider call blocked. Set ALLOW_LIVE_PERPLEXITY_PROVIDER=YES to authorize exactly one request.",
  );
}

const apiKey = requireEnv("PERPLEXITY_API_KEY");
const model = process.env.PERPLEXITY_BENCHMARK_MODEL?.trim() || "sonar";
const httpClient = new CountingFetchHttpJsonClient();
const provider = new PerplexityChatProvider({ apiKey, httpClient });

const benchmarkQuestion = "Which companies can help implement O-PAS-based Open Process Automation?";

console.log(`Perplexity benchmark provider model requested: ${model}`);
console.log("Making exactly one isolated Perplexity benchmark-provider request...");

const response = await provider.generate({
  platform: "perplexity",
  model,
  prompt: benchmarkQuestion,
});

if (httpClient.calls !== 1) {
  throw new Error(`Expected exactly one Perplexity provider HTTP request, observed ${httpClient.calls}.`);
}
if (!response.answer.trim()) throw new Error("Perplexity provider returned an empty answer.");
if (!response.model.trim()) throw new Error("Perplexity provider returned an empty model identifier.");

const sources = response.sources ?? [];
const uniqueDomains = [...new Set(sources.map((source) => source.domain))].sort();

console.log(`Perplexity benchmark provider model returned: ${response.model}`);
console.log(`Provider response ID present: ${response.rawProviderId ? "yes" : "no"}`);
console.log(`Answer length: ${response.answer.length} characters`);
console.log(`Sources extracted: ${sources.length}`);
console.log(`Unique source domains: ${uniqueDomains.length}`);
if (uniqueDomains.length > 0) console.log(`Source domains: ${uniqueDomains.join(", ")}`);
console.log("Answer preview:");
console.log(response.answer.slice(0, 1200));
console.log("Isolated Perplexity benchmark-provider validation completed.");
console.log("Exactly one Perplexity benchmark-provider request was made.");
console.log("No scorer calls, database writes, n8n calls, Google Sheets writes, or CSI production changes were made.");
