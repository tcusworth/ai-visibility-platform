import type { Observation, PlatformDefinition, PlatformKey, PromptDefinition } from "@ai-visibility/domain";
import { evaluateCompleteness } from "@ai-visibility/engine";
import { buildRunMetricSnapshot, type VisibilityMethodologyProfile } from "@ai-visibility/scoring";

const RUN_KEY = "offline-four-provider-finalization-v1";
const platforms = ["openai", "gemini", "perplexity", "claude"] as const;

const profile: VisibilityMethodologyProfile = {
  profileKey: "csi-production",
  version: "v1",
  recommendationThreshold: 4,
  primaryAuthorityThreshold: 5,
  providerSelectionIntent: "provider selection",
  successfulOnly: true,
  visibilityIndexWeights: {
    citationShare: 0.20,
    mentionShare: 0.30,
    recommendationShare: 0.30,
    weightedCommercialVisibility: 0.20,
  },
};

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  console.log(`${label}: passed`);
}

const prompt: PromptDefinition = {
  id: "offline-prompt-1",
  externalPromptId: "1",
  text: "Which companies can help implement O-PAS-based Open Process Automation?",
  category: "offline-finalization-fixture",
  intent: "Provider Selection",
  weight: 3,
  active: true,
};

const displayNames: Record<(typeof platforms)[number], string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  perplexity: "Perplexity",
  claude: "Claude",
};

const platformDefinitions: PlatformDefinition[] = platforms.map((key) => ({
  key,
  displayName: displayNames[key],
  model: `fixture-${key}`,
  enabled: true,
}));

function observation(
  platform: PlatformKey,
  input: { mentioned: boolean; cited: boolean; score: number },
): Observation {
  return {
    id: `offline-${platform}`,
    workspaceId: "offline-workspace",
    benchmarkRunId: "offline-run",
    benchmarkRunKey: RUN_KEY,
    promptId: prompt.id,
    platform,
    model: `fixture-${platform}`,
    status: "SUCCESS",
    sources: [],
    entities: [],
    targetMentioned: input.mentioned,
    targetCited: input.cited,
    targetRecommended: input.score >= 4,
    visibilityScore: input.score,
    weightedScore: input.score * prompt.weight,
    scorerVersion: "offline-finalization-fixture-v1",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

function main(): void {
  // Mirrors the shape of the successful four-provider live gate without reusing paid responses.
  const observations: Observation[] = [
    observation("openai", { mentioned: false, cited: false, score: 0 }),
    observation("gemini", { mentioned: false, cited: true, score: 0 }),
    observation("perplexity", { mentioned: true, cited: true, score: 4 }),
    observation("claude", { mentioned: false, cited: false, score: 0 }),
  ];

  const completeness = evaluateCompleteness({
    benchmarkRunKey: RUN_KEY,
    prompts: [prompt],
    platforms: platformDefinitions,
    observations,
  });

  assertEqual(completeness.expectedLogicalObservations, 4, "Expected logical observations = 4");
  assertEqual(completeness.successfulLogicalObservations, 4, "Successful logical observations = 4");
  assertEqual(completeness.failedLogicalObservations, 0, "Failed logical observations = 0");
  assertEqual(completeness.missingObservationKeys.length, 0, "Missing logical observations = 0");
  assertEqual(completeness.complete, true, "Run completeness = complete");

  const snapshot = buildRunMetricSnapshot({
    observations,
    prompts: [prompt],
    platformOrder: [...platforms],
    profile,
  });

  assertEqual(snapshot.successfulObservations, 4, "Snapshot successful observations = 4");
  assertEqual(snapshot.mentionCount, 1, "Mention count = 1");
  assertEqual(snapshot.citationCount, 2, "Citation count = 2");
  assertEqual(snapshot.recommendationCount, 1, "Recommendation count = 1");
  assertEqual(snapshot.mentionShare, 0.25, "Mention Share = 25%");
  assertEqual(snapshot.citationShare, 0.5, "Citation Share = 50%");
  assertEqual(snapshot.recommendationShare, 0.25, "Recommendation Share = 25%");
  assertEqual(snapshot.providerSelectionObservations, 4, "Provider Selection observations = 4");
  assertEqual(snapshot.providerSelectionRecommendationCount, 1, "Provider Selection recommendations = 1");
  assertEqual(snapshot.providerSelectionRecommendationShare, 0.25, "Provider Selection Recommendation Share = 25%");

  const expectedPlatformIndexes: Record<(typeof platforms)[number], number> = {
    openai: 0,
    gemini: 20,
    perplexity: 96,
    claude: 0,
  };

  for (const platform of platforms) {
    const metric = snapshot.platforms.find((item) => item.platform === platform);
    if (!metric) throw new Error(`Missing platform metric for ${platform}.`);
    assertEqual(metric.successfulObservations, 1, `${platform} successful observations = 1`);
    assertEqual(metric.visibilityIndex, expectedPlatformIndexes[platform], `${platform} Visibility Index`);
  }

  assertEqual(snapshot.visibilityIndex, 29, "Overall Visibility Index = average of rounded platform indices");

  const logicalKeys = new Set(observations.map((item) => `${item.benchmarkRunKey}|${item.promptId}|${item.platform}`));
  assertEqual(logicalKeys.size, 4, "No duplicate logical observations");

  console.log("Offline four-provider finalization validation passed.");
  console.log("Completeness, successful-only aggregation, recommendation threshold, Provider Selection metrics, per-platform indices, and overall Visibility Index were validated.");
  console.log("No provider/model API calls, database writes, n8n calls, Google Sheets writes, CSI production changes, or existing shadow-run changes were made.");
}

main();
