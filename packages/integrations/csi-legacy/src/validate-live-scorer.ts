import {
  buildVisibilityScorerPrompt,
  normalizeScorerClassification,
  type VisibilityScorerPromptProfile,
} from "@ai-visibility/scoring";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";

class FetchHttpJsonClient implements HttpJsonClient {
  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
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

if (process.env.ALLOW_LIVE_SCORER !== "YES") {
  throw new Error("Live scorer call blocked. Set ALLOW_LIVE_SCORER=YES explicitly to authorize exactly one isolated scorer request.");
}

const apiKey = requireEnv("OPENAI_API_KEY");
const model = process.env.SCORER_MODEL?.trim() || "gpt-5.4-nano";

const profile: VisibilityScorerPromptProfile = {
  targetDisplayName: "Collaborative Systems Integration",
  targetShortName: "CSI",
  targetReferences: [
    "Collaborative Systems Integration",
    "CSI Automation",
    "csi-automation.com",
    "Collaborative Systems Integration (CSI)",
  ],
  mentionedField: "csi_mentioned",
  citedField: "csi_cited",
  positioningField: "csi_positioning",
  allowedEntityTypes: [
    "Integrator / Consultant",
    "Automation Vendor",
    "Technology Supplier",
    "Owner / Operator",
    "Standards / Industry Body",
    "Other",
  ],
  controlledSourceExample: "csi-automation.com",
};

const benchmarkPrompt = "Which companies can help implement O-PAS-based Open Process Automation?";
const answer = "Collaborative Systems Integration (CSI) is one systems integrator to consider for O-PAS implementation work. The Open Group maintains the O-PAS standard.";
const sourceUrls = [
  "https://csi-automation.com/open-process-automation",
  "https://www.opengroup.org/open-process-automation-forum",
];
const sourceDomains = ["csi-automation.com", "opengroup.org"];

const scoringPrompt = buildVisibilityScorerPrompt({
  profile,
  platform: "OpenAI",
  model: "synthetic-provider-model",
  prompt: benchmarkPrompt,
  answer,
  sourceUrls,
  sourceDomains,
});

const scorer = new OpenAIResponsesScorerClient({
  apiKey,
  model,
  httpClient: new FetchHttpJsonClient(),
});

console.log(`Scorer model requested: ${model}`);
console.log("Making exactly one isolated OpenAI scorer request...");

const response = await scorer.score({ prompt: scoringPrompt });
const normalized = normalizeScorerClassification({
  rawText: response.rawText,
  sourceDomains,
  sourceUrls,
  ownedDomains: ["csi-automation.com"],
  promptWeight: 3,
  scorerVersion: `openai:${response.model}`,
  recommendationThreshold: 4,
});

console.log(`Scorer model returned: ${response.model}`);
console.log(`Response ID present: ${response.responseId ? "yes" : "no"}`);
console.log(`Target mentioned: ${normalized.targetMentioned}`);
console.log(`Target cited: ${normalized.targetCited}`);
console.log(`Visibility score: ${normalized.visibilityScore}`);
console.log(`Target recommended: ${normalized.targetRecommended}`);
console.log(`Weighted score: ${normalized.weightedScore}`);
console.log(`Parse failed: ${normalized.parseFailed}`);
console.log(`Entities extracted: ${normalized.entities.length}`);
console.log(`Positioning: ${normalized.targetPositioning}`);
console.log(`Notes: ${normalized.notes}`);
console.log("Isolated live scorer validation completed.");
console.log("No benchmark provider calls, database writes, n8n calls, or CSI production changes were made.");
