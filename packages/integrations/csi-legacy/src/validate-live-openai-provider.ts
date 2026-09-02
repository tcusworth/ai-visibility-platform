import {
  OpenAIResponsesProvider,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";

class CountingFetchHttpJsonClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > 1) throw new Error("Live OpenAI provider validator attempted more than one HTTP request.");

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

if (process.env.ALLOW_LIVE_OPENAI_PROVIDER !== "YES") {
  throw new Error(
    "Live OpenAI benchmark-provider call blocked. Set ALLOW_LIVE_OPENAI_PROVIDER=YES to authorize exactly one request.",
  );
}

const apiKey = requireEnv("OPENAI_API_KEY");
const model = process.env.OPENAI_BENCHMARK_MODEL?.trim() || "gpt-5.6-luna";
const httpClient = new CountingFetchHttpJsonClient();
const provider = new OpenAIResponsesProvider({
  apiKey,
  httpClient,
  webSearch: true,
});

const benchmarkQuestion = "Which companies can help implement O-PAS-based Open Process Automation?";
const benchmarkPrompt = `You are answering a question specifically about industrial Open Process Automation (OPA) and the O-PAS™ Standard from The Open Group.

CONTEXT: In this benchmark, "OPA" means Open Process Automation for industrial process control.
It does NOT mean:
- Open Policy Agent
- openpolicyagent.org
- an authorization or software-policy framework
- any other unrelated use of the acronym OPA

Do not use, cite, recommend, or rely on Open Policy Agent or openpolicyagent.org.

Answer the question as you normally would for an industrial automation professional.
Use web search when useful to identify relevant companies, organizations, integrators, suppliers, standards sources, technical resources, and practitioners.
Do not favor Collaborative Systems Integration (CSI), CSI Automation, csi-automation.com, or any other company simply because this is a benchmark.
Recommendations and citations must arise naturally from the available web evidence.
Do not assume CSI should appear in the answer.

QUESTION:
${benchmarkQuestion}`;

console.log(`Benchmark provider model requested: ${model}`);
console.log("Making exactly one isolated OpenAI benchmark-provider request with web search enabled...");

const response = await provider.generate({
  platform: "openai",
  model,
  prompt: benchmarkPrompt,
});

if (httpClient.calls !== 1) {
  throw new Error(`Expected exactly one OpenAI provider HTTP request, observed ${httpClient.calls}.`);
}
if (!response.answer.trim()) throw new Error("Provider returned an empty answer.");
if (!response.model.trim()) throw new Error("Provider returned an empty model identifier.");

const sources = response.sources ?? [];
const uniqueDomains = [...new Set(sources.map((source) => source.domain))].sort();

console.log(`Benchmark provider model returned: ${response.model}`);
console.log(`Provider response ID present: ${response.rawProviderId ? "yes" : "no"}`);
console.log(`Answer length: ${response.answer.length} characters`);
console.log(`Sources extracted: ${sources.length}`);
console.log(`Unique source domains: ${uniqueDomains.length}`);
if (uniqueDomains.length > 0) {
  console.log(`Source domains: ${uniqueDomains.join(", ")}`);
}
console.log("Answer preview:");
console.log(response.answer.slice(0, 1200));
console.log("Isolated OpenAI benchmark-provider validation completed.");
console.log("Exactly one OpenAI benchmark-provider request was made.");
console.log("No scorer calls, database writes, n8n calls, Google Sheets writes, or CSI production changes were made.");
