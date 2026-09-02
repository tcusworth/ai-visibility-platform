import {
  calculateOverallVisibilityIndex,
  calculatePlatformMetrics,
  isPrimaryAuthority,
  isProviderSelectionIntent,
  isRecommendation,
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

const baseline = [
  {
    platform: "Gemini",
    input: {
      successfulObservations: 100,
      mentionCount: 25,
      citationCount: 60,
      recommendationCount: 5,
      weightedCommercialVisibilityShare: 0.14,
      providerSelectionObservations: 29,
      providerSelectionRecommendationCount: 5,
    },
    expectedVisibilityIndex: 23.8,
  },
  {
    platform: "Perplexity",
    input: {
      successfulObservations: 100,
      mentionCount: 76,
      citationCount: 80,
      recommendationCount: 46,
      weightedCommercialVisibilityShare: 0.525,
      providerSelectionObservations: 29,
      providerSelectionRecommendationCount: 17,
    },
    expectedVisibilityIndex: 63.1,
  },
  {
    platform: "Claude",
    input: {
      successfulObservations: 100,
      mentionCount: 38,
      citationCount: 46,
      recommendationCount: 7,
      weightedCommercialVisibilityShare: 0.20,
      providerSelectionObservations: 29,
      providerSelectionRecommendationCount: 6,
    },
    expectedVisibilityIndex: 26.7,
  },
  {
    platform: "OpenAI",
    input: {
      successfulObservations: 100,
      mentionCount: 24,
      citationCount: 19,
      recommendationCount: 19,
      weightedCommercialVisibilityShare: 0.19,
      providerSelectionObservations: 29,
      providerSelectionRecommendationCount: 17,
    },
    expectedVisibilityIndex: 20.5,
  },
] as const;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertClose(actual: number, expected: number, label: string, tolerance = 1e-10): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function main(): void {
  assertEqual(profile.successfulOnly, true, "Successful-only denominator rule");
  assertEqual(isRecommendation(4, profile), true, "Recommendation threshold at 4");
  assertEqual(isRecommendation(3, profile), false, "Recommendation threshold below 4");
  assertEqual(isPrimaryAuthority(5, profile), true, "Primary authority threshold at 5");
  assertEqual(isPrimaryAuthority(4, profile), false, "Primary authority threshold below 5");
  assertEqual(isProviderSelectionIntent(" Provider   Selection ", profile), true, "Provider Selection normalization");

  const indices: number[] = [];
  let totalMentions = 0;
  let totalCitations = 0;
  let totalRecommendations = 0;
  let totalSuccessful = 0;
  let totalProviderSelection = 0;
  let totalProviderSelectionRecommendations = 0;

  for (const item of baseline) {
    const metrics = calculatePlatformMetrics(item.input, profile);
    assertEqual(metrics.visibilityIndex, item.expectedVisibilityIndex, `${item.platform} Visibility Index`);
    indices.push(metrics.visibilityIndex);
    totalMentions += item.input.mentionCount;
    totalCitations += item.input.citationCount;
    totalRecommendations += item.input.recommendationCount;
    totalSuccessful += item.input.successfulObservations;
    totalProviderSelection += item.input.providerSelectionObservations;
    totalProviderSelectionRecommendations += item.input.providerSelectionRecommendationCount;
    console.log(`${item.platform} Visibility Index: ${metrics.visibilityIndex}`);
  }

  const overallVisibilityIndex = calculateOverallVisibilityIndex(indices);
  const mentionShare = totalMentions / totalSuccessful;
  const citationShare = totalCitations / totalSuccessful;
  const recommendationShare = totalRecommendations / totalSuccessful;
  const providerSelectionRecommendationShare = totalProviderSelectionRecommendations / totalProviderSelection;

  assertClose(mentionShare, 0.4075, "CSI Mention Share");
  assertClose(citationShare, 0.5125, "Citation Share");
  assertClose(recommendationShare, 0.1925, "Recommendation Share");
  assertClose(overallVisibilityIndex, 33.525, "Overall Visibility Index");
  assertClose(providerSelectionRecommendationShare, 45 / 116, "Provider Selection Recommendation Share");

  console.log(`Mention Share: ${(mentionShare * 100).toFixed(2)}% (${totalMentions}/${totalSuccessful})`);
  console.log(`Citation Share: ${(citationShare * 100).toFixed(2)}% (${totalCitations}/${totalSuccessful})`);
  console.log(`Recommendation Share: ${(recommendationShare * 100).toFixed(2)}% (${totalRecommendations}/${totalSuccessful})`);
  console.log(`Visibility Index: ${overallVisibilityIndex}`);
  console.log(`Provider Selection Recommendation Share: ${(providerSelectionRecommendationShare * 100).toFixed(4)}% (${totalProviderSelectionRecommendations}/${totalProviderSelection})`);
  console.log("CSI production methodology parity validation passed.");
  console.log("No database writes or provider/model API calls were made.");
}

main();
