import type { Observation, PromptDefinition } from "@ai-visibility/domain";
import {
  buildRunMetricSnapshot,
  buildVisibilityScorerPrompt,
  normalizeScorerClassification,
  type VisibilityMethodologyProfile,
  type VisibilityScorerPromptProfile,
} from "@ai-visibility/scoring";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
  console.log(`${label}: passed`);
}

const prompt: PromptDefinition = {
  id: "prompt-1",
  externalPromptId: "1",
  text: "Which companies can help implement O-PAS-based Open Process Automation?",
  category: "Commercial",
  intent: "Provider Selection",
  weight: 3,
  active: true,
};

const scorerPromptProfile: VisibilityScorerPromptProfile = {
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
  controlledSourceExample: "csi-automation.com",
  allowedEntityTypes: [
    "Integrator / Consultant",
    "Automation Vendor",
    "Technology Supplier",
    "Owner / Operator",
    "Standards / Industry Body",
    "Other",
  ],
};

const methodology: VisibilityMethodologyProfile = {
  profileKey: "csi-production",
  version: "v1",
  recommendationThreshold: 4,
  primaryAuthorityThreshold: 5,
  providerSelectionIntent: "provider selection",
  successfulOnly: true,
  visibilityIndexWeights: {
    citationShare: 0.2,
    mentionShare: 0.3,
    recommendationShare: 0.3,
    weightedCommercialVisibility: 0.2,
  },
};

const providerAnswer = "Collaborative Systems Integration (CSI) is one integrator to consider for O-PAS implementation work.";
const sourceUrls = ["https://csi-automation.com/open-process-automation"];
const sourceDomains = ["csi-automation.com"];

const scorerPrompt = buildVisibilityScorerPrompt({
  profile: scorerPromptProfile,
  platform: "OpenAI",
  model: "fake-provider-model",
  prompt: prompt.text,
  answer: providerAnswer,
  sourceUrls,
  sourceDomains,
});

assertEqual(scorerPrompt.includes(providerAnswer), true, "Provider answer included in scorer prompt");
assertEqual(scorerPrompt.includes("csi-automation.com"), true, "Owned source included in scorer prompt");
assertEqual(scorerPrompt.includes("4 = CSI is recommended"), true, "Production score 4 rule included");

const fakeScorerResponse = JSON.stringify({
  csi_mentioned: true,
  csi_cited: false,
  visibility_score: 4,
  csi_positioning: "CSI is presented as a relevant implementation provider.",
  entities: [
    { name: "The Open Group", type: "Standards / Industry Body" },
  ],
  notes: "Synthetic offline scorer response.",
});

const normalized = normalizeScorerClassification({
  rawText: fakeScorerResponse,
  sourceDomains,
  sourceUrls,
  ownedDomains: ["csi-automation.com"],
  promptWeight: prompt.weight,
  scorerVersion: "offline-pipeline-v1",
  recommendationThreshold: methodology.recommendationThreshold,
});

assertEqual(normalized.targetMentioned, true, "Target mention normalized");
assertEqual(normalized.targetCited, true, "Owned-source citation override applied");
assertEqual(normalized.visibilityScore, 4, "Visibility score normalized");
assertEqual(normalized.targetRecommended, true, "Recommendation derived from score");
assertEqual(normalized.weightedScore, 12, "Weighted score calculated");
assertEqual(normalized.entities.length, 1, "Entity extraction preserved");

const observation: Observation = {
  id: "observation-1",
  workspaceId: "workspace-csi",
  benchmarkRunId: "run-1",
  benchmarkRunKey: "offline-pipeline-v1",
  promptId: prompt.id,
  platform: "openai",
  model: "fake-provider-model",
  status: "SUCCESS",
  answer: providerAnswer,
  sources: sourceUrls.map((url) => ({ url, domain: "csi-automation.com", ownedByTarget: true })),
  entities: normalized.entities.map((entity) => ({ canonicalName: entity.name, type: "other" })),
  targetMentioned: normalized.targetMentioned,
  targetCited: normalized.targetCited,
  targetRecommended: normalized.targetRecommended,
  targetPositioning: normalized.targetPositioning,
  visibilityScore: normalized.visibilityScore,
  weightedScore: normalized.weightedScore,
  scorerVersion: normalized.scorerVersion,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const snapshot = buildRunMetricSnapshot({
  observations: [observation],
  prompts: [prompt],
  platformOrder: ["openai"],
  profile: methodology,
});

assertEqual(snapshot.successfulObservations, 1, "Snapshot successful observation count");
assertEqual(snapshot.mentionCount, 1, "Snapshot mention count");
assertEqual(snapshot.citationCount, 1, "Snapshot citation count");
assertEqual(snapshot.recommendationCount, 1, "Snapshot recommendation count");
assertEqual(snapshot.providerSelectionObservations, 1, "Provider Selection denominator");
assertEqual(snapshot.providerSelectionRecommendationCount, 1, "Provider Selection recommendation count");
assertEqual(snapshot.platforms[0]?.visibilityIndex, 96, "End-to-end platform Visibility Index");
assertEqual(snapshot.visibilityIndex, 96, "End-to-end run Visibility Index");

console.log("Offline end-to-end scorer pipeline validation passed.");
console.log("No database writes or provider/model API calls were made.");
