import type { Observation, PlatformKey, PromptDefinition } from "@ai-visibility/domain";
import {
  calculateOverallVisibilityIndex,
  calculatePlatformMetrics,
  isProviderSelectionIntent,
  isRecommendation,
  type PlatformMetricInput,
  type VisibilityMethodologyProfile,
} from "./methodology.js";

export interface PlatformMetricSnapshot {
  platform: PlatformKey;
  successfulObservations: number;
  mentionCount: number;
  citationCount: number;
  recommendationCount: number;
  mentionShare: number;
  citationShare: number;
  recommendationShare: number;
  weightedCommercialVisibilityShare: number;
  visibilityIndex: number;
  providerSelectionObservations: number;
  providerSelectionRecommendationCount: number;
  providerSelectionRecommendationShare: number;
}

export interface RunMetricSnapshot {
  successfulObservations: number;
  mentionCount: number;
  citationCount: number;
  recommendationCount: number;
  mentionShare: number;
  citationShare: number;
  recommendationShare: number;
  visibilityIndex: number;
  providerSelectionObservations: number;
  providerSelectionRecommendationCount: number;
  providerSelectionRecommendationShare: number;
  platforms: PlatformMetricSnapshot[];
}

export interface SnapshotBuildInput {
  observations: Observation[];
  prompts: PromptDefinition[];
  platformOrder: PlatformKey[];
  profile: VisibilityMethodologyProfile;
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function canonicalNumber(value: number, decimals = 10): number {
  return Number(value.toFixed(decimals));
}

function buildPlatformInput(
  observations: Observation[],
  promptById: Map<string, PromptDefinition>,
  profile: VisibilityMethodologyProfile,
): PlatformMetricInput {
  const successful = observations.filter((observation) => observation.status === "SUCCESS");
  if (successful.length === 0) throw new Error("A platform snapshot requires at least one successful observation.");

  let mentionCount = 0;
  let citationCount = 0;
  let recommendationCount = 0;
  let providerSelectionObservations = 0;
  let providerSelectionRecommendationCount = 0;
  let weightedScoreTotal = 0;
  let promptWeightTotal = 0;

  for (const observation of successful) {
    const prompt = promptById.get(observation.promptId);
    if (!prompt) throw new Error(`Prompt not found for observation ${observation.id}.`);
    if (observation.visibilityScore === undefined) throw new Error(`Observation ${observation.id} is missing visibilityScore.`);

    const recommended = isRecommendation(observation.visibilityScore, profile);
    if (observation.targetMentioned === true) mentionCount += 1;
    if (observation.targetCited === true) citationCount += 1;
    if (recommended) recommendationCount += 1;

    if (isProviderSelectionIntent(prompt.intent, profile)) {
      providerSelectionObservations += 1;
      if (recommended) providerSelectionRecommendationCount += 1;
    }

    weightedScoreTotal += observation.visibilityScore * prompt.weight;
    promptWeightTotal += prompt.weight;
  }

  if (promptWeightTotal <= 0) throw new Error("Successful observation prompt weights must sum to more than zero.");

  return {
    successfulObservations: successful.length,
    mentionCount,
    citationCount,
    recommendationCount,
    weightedCommercialVisibilityShare: weightedScoreTotal / (5 * promptWeightTotal),
    providerSelectionObservations,
    providerSelectionRecommendationCount,
  };
}

export function buildRunMetricSnapshot(input: SnapshotBuildInput): RunMetricSnapshot {
  const promptById = new Map(input.prompts.map((prompt) => [prompt.id, prompt]));
  const successful = input.observations.filter((observation) => observation.status === "SUCCESS");
  if (successful.length === 0) throw new Error("A run snapshot requires at least one successful observation.");

  const platforms: PlatformMetricSnapshot[] = input.platformOrder.map((platform) => {
    const platformObservations = successful.filter((observation) => observation.platform === platform);
    const metricInput = buildPlatformInput(platformObservations, promptById, input.profile);
    const metrics = calculatePlatformMetrics(metricInput, input.profile);
    return {
      platform,
      successfulObservations: metricInput.successfulObservations,
      mentionCount: metricInput.mentionCount,
      citationCount: metricInput.citationCount,
      recommendationCount: metricInput.recommendationCount,
      mentionShare: canonicalNumber(metrics.mentionShare),
      citationShare: canonicalNumber(metrics.citationShare),
      recommendationShare: canonicalNumber(metrics.recommendationShare),
      weightedCommercialVisibilityShare: canonicalNumber(metrics.weightedCommercialVisibilityShare),
      visibilityIndex: metrics.visibilityIndex,
      providerSelectionObservations: metricInput.providerSelectionObservations,
      providerSelectionRecommendationCount: metricInput.providerSelectionRecommendationCount,
      providerSelectionRecommendationShare: canonicalNumber(metrics.providerSelectionRecommendationShare),
    };
  });

  const mentionCount = platforms.reduce((sum, platform) => sum + platform.mentionCount, 0);
  const citationCount = platforms.reduce((sum, platform) => sum + platform.citationCount, 0);
  const recommendationCount = platforms.reduce((sum, platform) => sum + platform.recommendationCount, 0);
  const providerSelectionObservations = platforms.reduce((sum, platform) => sum + platform.providerSelectionObservations, 0);
  const providerSelectionRecommendationCount = platforms.reduce((sum, platform) => sum + platform.providerSelectionRecommendationCount, 0);

  return {
    successfulObservations: successful.length,
    mentionCount,
    citationCount,
    recommendationCount,
    mentionShare: canonicalNumber(divide(mentionCount, successful.length)),
    citationShare: canonicalNumber(divide(citationCount, successful.length)),
    recommendationShare: canonicalNumber(divide(recommendationCount, successful.length)),
    visibilityIndex: canonicalNumber(calculateOverallVisibilityIndex(platforms.map((platform) => platform.visibilityIndex))),
    providerSelectionObservations,
    providerSelectionRecommendationCount,
    providerSelectionRecommendationShare: canonicalNumber(divide(providerSelectionRecommendationCount, providerSelectionObservations)),
    platforms,
  };
}
