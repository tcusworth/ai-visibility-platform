import type { Observation, PlatformKey, PromptDefinition } from "@ai-visibility/domain";
import {
  buildRunMetricSnapshot,
  type VisibilityMethodologyProfile,
} from "@ai-visibility/scoring";

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

const platformFixtures = [
  {
    platform: "gemini",
    mentionCount: 25,
    citationCount: 60,
    recommendationCount: 5,
    providerSelectionRecommendationCount: 5,
    weightedCommercialVisibilityShare: 0.14,
    visibilityIndex: 23.8,
  },
  {
    platform: "perplexity",
    mentionCount: 76,
    citationCount: 80,
    recommendationCount: 46,
    providerSelectionRecommendationCount: 17,
    weightedCommercialVisibilityShare: 0.525,
    visibilityIndex: 63.1,
  },
  {
    platform: "claude",
    mentionCount: 38,
    citationCount: 46,
    recommendationCount: 7,
    providerSelectionRecommendationCount: 6,
    weightedCommercialVisibilityShare: 0.20,
    visibilityIndex: 26.7,
  },
  {
    platform: "openai",
    mentionCount: 24,
    citationCount: 19,
    recommendationCount: 19,
    providerSelectionRecommendationCount: 17,
    weightedCommercialVisibilityShare: 0.19,
    visibilityIndex: 20.5,
  },
] as const;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function makePrompts(): PromptDefinition[] {
  return Array.from({ length: 100 }, (_, index) => {
    const promptNumber = index + 1;
    return {
      id: `prompt-${promptNumber}`,
      externalPromptId: String(promptNumber),
      text: `Synthetic CSI baseline prompt ${promptNumber}`,
      category: "synthetic-parity-fixture",
      intent: promptNumber <= 29 ? "Provider Selection" : "general visibility",
      weight: 1,
      active: true,
    };
  });
}

function recommendationPromptNumbers(total: number, providerSelectionTotal: number): Set<number> {
  const values = new Set<number>();
  for (let promptNumber = 1; promptNumber <= providerSelectionTotal; promptNumber += 1) {
    values.add(promptNumber);
  }
  let promptNumber = 30;
  while (values.size < total) {
    values.add(promptNumber);
    promptNumber += 1;
  }
  return values;
}

function makePlatformObservations(
  platform: PlatformKey,
  mentionCount: number,
  citationCount: number,
  recommendationCount: number,
  providerSelectionRecommendationCount: number,
  weightedCommercialVisibilityShare: number,
): Observation[] {
  const recommendedPrompts = recommendationPromptNumbers(
    recommendationCount,
    providerSelectionRecommendationCount,
  );

  const requiredVisibilityScoreTotal = weightedCommercialVisibilityShare * 5 * 100;
  const recommendedScoreTotal = recommendationCount * 4;
  const nonRecommendedCount = 100 - recommendationCount;
  const nonRecommendedScore = nonRecommendedCount === 0
    ? 0
    : (requiredVisibilityScoreTotal - recommendedScoreTotal) / nonRecommendedCount;

  if (nonRecommendedScore >= profile.recommendationThreshold) {
    throw new Error(`${platform} synthetic non-recommendation score crossed the recommendation threshold.`);
  }

  return Array.from({ length: 100 }, (_, index) => {
    const promptNumber = index + 1;
    const recommended = recommendedPrompts.has(promptNumber);
    const visibilityScore = recommended ? 4 : nonRecommendedScore;
    return {
      id: `${platform}-observation-${promptNumber}`,
      workspaceId: "csi-fixture-workspace",
      benchmarkRunId: "csi-baseline-fixture-run",
      benchmarkRunKey: "2026-08-27-full100-v1",
      promptId: `prompt-${promptNumber}`,
      platform,
      model: `fixture-${platform}`,
      status: "SUCCESS",
      sources: [],
      entities: [],
      targetMentioned: promptNumber <= mentionCount,
      targetCited: promptNumber <= citationCount,
      // Deliberately false. Snapshot recommendation must be derived from visibilityScore >= 4.
      targetRecommended: false,
      visibilityScore,
      weightedScore: visibilityScore,
      scorerVersion: "csi-production-fixture-v1",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
  });
}

function main(): void {
  const prompts = makePrompts();
  const observations = platformFixtures.flatMap((fixture) => makePlatformObservations(
    fixture.platform,
    fixture.mentionCount,
    fixture.citationCount,
    fixture.recommendationCount,
    fixture.providerSelectionRecommendationCount,
    fixture.weightedCommercialVisibilityShare,
  ));

  assertEqual(prompts.length, 100, "Fixture prompt count");
  assertEqual(observations.length, 400, "Fixture observation count");

  const snapshot = buildRunMetricSnapshot({
    observations,
    prompts,
    platformOrder: platformFixtures.map((fixture) => fixture.platform),
    profile,
  });

  assertEqual(snapshot.successfulObservations, 400, "Successful observation count");
  assertEqual(snapshot.mentionCount, 163, "Mention count");
  assertEqual(snapshot.citationCount, 205, "Citation count");
  assertEqual(snapshot.recommendationCount, 77, "Recommendation count");
  assertEqual(snapshot.mentionShare, 0.4075, "Mention Share");
  assertEqual(snapshot.citationShare, 0.5125, "Citation Share");
  assertEqual(snapshot.recommendationShare, 0.1925, "Recommendation Share");
  assertEqual(snapshot.visibilityIndex, 33.525, "Canonical overall Visibility Index");
  assertEqual(snapshot.providerSelectionObservations, 116, "Provider Selection observations");
  assertEqual(snapshot.providerSelectionRecommendationCount, 45, "Provider Selection recommendations");
  assertEqual(snapshot.providerSelectionRecommendationShare, 0.3879310345, "Provider Selection Recommendation Share");

  for (const fixture of platformFixtures) {
    const platform = snapshot.platforms.find((item) => item.platform === fixture.platform);
    if (!platform) throw new Error(`Missing platform snapshot for ${fixture.platform}.`);
    assertEqual(platform.successfulObservations, 100, `${fixture.platform} successful observations`);
    assertEqual(platform.mentionCount, fixture.mentionCount, `${fixture.platform} mention count`);
    assertEqual(platform.citationCount, fixture.citationCount, `${fixture.platform} citation count`);
    assertEqual(platform.recommendationCount, fixture.recommendationCount, `${fixture.platform} recommendation count`);
    assertEqual(
      platform.providerSelectionRecommendationCount,
      fixture.providerSelectionRecommendationCount,
      `${fixture.platform} Provider Selection recommendation count`,
    );
    assertEqual(
      platform.weightedCommercialVisibilityShare,
      fixture.weightedCommercialVisibilityShare,
      `${fixture.platform} weighted commercial visibility`,
    );
    assertEqual(platform.visibilityIndex, fixture.visibilityIndex, `${fixture.platform} Visibility Index`);
    console.log(`${fixture.platform} Visibility Index: ${platform.visibilityIndex}`);
  }

  console.log(`Mention Share: ${(snapshot.mentionShare * 100).toFixed(2)}% (${snapshot.mentionCount}/${snapshot.successfulObservations})`);
  console.log(`Citation Share: ${(snapshot.citationShare * 100).toFixed(2)}% (${snapshot.citationCount}/${snapshot.successfulObservations})`);
  console.log(`Recommendation Share: ${(snapshot.recommendationShare * 100).toFixed(2)}% (${snapshot.recommendationCount}/${snapshot.successfulObservations})`);
  console.log(`Visibility Index: ${snapshot.visibilityIndex}`);
  console.log(`Provider Selection Recommendation Share: ${(snapshot.providerSelectionRecommendationShare * 100).toFixed(4)}% (${snapshot.providerSelectionRecommendationCount}/${snapshot.providerSelectionObservations})`);
  console.log("CSI metric snapshot parity validation passed.");
  console.log("No database writes or provider/model API calls were made.");
}

main();
