export interface VisibilityIndexWeights {
  citationShare: number;
  mentionShare: number;
  recommendationShare: number;
  weightedCommercialVisibility: number;
}

export interface VisibilityMethodologyProfile {
  profileKey: string;
  version: string;
  recommendationThreshold: number;
  primaryAuthorityThreshold: number;
  providerSelectionIntent: string;
  successfulOnly: boolean;
  visibilityIndexWeights: VisibilityIndexWeights;
}

export interface PlatformMetricInput {
  successfulObservations: number;
  mentionCount: number;
  citationCount: number;
  recommendationCount: number;
  weightedCommercialVisibilityShare: number;
  providerSelectionObservations: number;
  providerSelectionRecommendationCount: number;
}

export interface PlatformMetricResult {
  mentionShare: number;
  citationShare: number;
  recommendationShare: number;
  weightedCommercialVisibilityShare: number;
  visibilityIndex: number;
  providerSelectionRecommendationShare: number;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function assertShare(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
}

export function normalizeIntent(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isProviderSelectionIntent(intent: string, profile: VisibilityMethodologyProfile): boolean {
  return normalizeIntent(intent) === normalizeIntent(profile.providerSelectionIntent);
}

export function isRecommendation(visibilityScore: number, profile: VisibilityMethodologyProfile): boolean {
  if (!Number.isFinite(visibilityScore)) throw new Error("visibilityScore must be finite.");
  return visibilityScore >= profile.recommendationThreshold;
}

export function isPrimaryAuthority(visibilityScore: number, profile: VisibilityMethodologyProfile): boolean {
  if (!Number.isFinite(visibilityScore)) throw new Error("visibilityScore must be finite.");
  return visibilityScore >= profile.primaryAuthorityThreshold;
}

export function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function calculatePlatformMetrics(
  input: PlatformMetricInput,
  profile: VisibilityMethodologyProfile,
): PlatformMetricResult {
  assertNonNegativeInteger("successfulObservations", input.successfulObservations);
  assertNonNegativeInteger("mentionCount", input.mentionCount);
  assertNonNegativeInteger("citationCount", input.citationCount);
  assertNonNegativeInteger("recommendationCount", input.recommendationCount);
  assertNonNegativeInteger("providerSelectionObservations", input.providerSelectionObservations);
  assertNonNegativeInteger("providerSelectionRecommendationCount", input.providerSelectionRecommendationCount);
  assertShare("weightedCommercialVisibilityShare", input.weightedCommercialVisibilityShare);

  if (input.successfulObservations === 0) {
    throw new Error("successfulObservations must be greater than zero for platform metrics.");
  }
  if (input.mentionCount > input.successfulObservations) throw new Error("mentionCount exceeds successfulObservations.");
  if (input.citationCount > input.successfulObservations) throw new Error("citationCount exceeds successfulObservations.");
  if (input.recommendationCount > input.successfulObservations) throw new Error("recommendationCount exceeds successfulObservations.");
  if (input.providerSelectionRecommendationCount > input.providerSelectionObservations) {
    throw new Error("providerSelectionRecommendationCount exceeds providerSelectionObservations.");
  }

  const mentionShare = input.mentionCount / input.successfulObservations;
  const citationShare = input.citationCount / input.successfulObservations;
  const recommendationShare = input.recommendationCount / input.successfulObservations;
  const providerSelectionRecommendationShare = input.providerSelectionObservations === 0
    ? 0
    : input.providerSelectionRecommendationCount / input.providerSelectionObservations;

  const weights = profile.visibilityIndexWeights;
  const weightTotal = weights.citationShare + weights.mentionShare + weights.recommendationShare + weights.weightedCommercialVisibility;
  if (Math.abs(weightTotal - 1) > 1e-9) throw new Error("Visibility Index weights must sum to 1.");

  const rawVisibilityIndex = 100 * (
    weights.citationShare * citationShare
    + weights.mentionShare * mentionShare
    + weights.recommendationShare * recommendationShare
    + weights.weightedCommercialVisibility * input.weightedCommercialVisibilityShare
  );

  return {
    mentionShare,
    citationShare,
    recommendationShare,
    weightedCommercialVisibilityShare: input.weightedCommercialVisibilityShare,
    visibilityIndex: roundOneDecimal(rawVisibilityIndex),
    providerSelectionRecommendationShare,
  };
}

export function calculateOverallVisibilityIndex(platformVisibilityIndices: number[]): number {
  if (platformVisibilityIndices.length === 0) throw new Error("At least one platform Visibility Index is required.");
  for (const value of platformVisibilityIndices) {
    if (!Number.isFinite(value)) throw new Error("Platform Visibility Index values must be finite.");
  }
  return platformVisibilityIndices.reduce((sum, value) => sum + value, 0) / platformVisibilityIndices.length;
}
