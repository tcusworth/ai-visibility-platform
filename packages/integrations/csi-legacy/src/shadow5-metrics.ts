import { randomUUID } from "node:crypto";
import type { MetricSnapshotRecord } from "@ai-visibility/database";
import type { BenchmarkRun } from "@ai-visibility/domain";
import type { RunMetricSnapshot } from "@ai-visibility/scoring";

export function buildShadow5MetricSnapshotRecords(
  run: BenchmarkRun,
  snapshot: RunMetricSnapshot,
  createdAt = new Date().toISOString(),
): MetricSnapshotRecord[] {
  const records: MetricSnapshotRecord[] = [];

  const add = (
    metricKey: string,
    scopeType: string,
    scopeKey: string,
    value: number,
    numerator: number | null = null,
    denominator: number | null = null,
  ): void => {
    records.push({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      benchmarkRunId: run.id,
      metricKey,
      scopeType,
      scopeKey,
      value,
      numerator,
      denominator,
      methodologyVersion: run.methodologyVersion,
      createdAt,
    });
  };

  add("successful_observations", "overall", "overall", snapshot.successfulObservations);
  add("mention_count", "overall", "overall", snapshot.mentionCount);
  add("citation_count", "overall", "overall", snapshot.citationCount);
  add("recommendation_count", "overall", "overall", snapshot.recommendationCount);
  add("mention_share", "overall", "overall", snapshot.mentionShare, snapshot.mentionCount, snapshot.successfulObservations);
  add("citation_share", "overall", "overall", snapshot.citationShare, snapshot.citationCount, snapshot.successfulObservations);
  add(
    "recommendation_share",
    "overall",
    "overall",
    snapshot.recommendationShare,
    snapshot.recommendationCount,
    snapshot.successfulObservations,
  );
  add("visibility_index", "overall", "overall", snapshot.visibilityIndex);
  add("provider_selection_observations", "overall", "overall", snapshot.providerSelectionObservations);
  add(
    "provider_selection_recommendation_count",
    "overall",
    "overall",
    snapshot.providerSelectionRecommendationCount,
  );
  add(
    "provider_selection_recommendation_share",
    "overall",
    "overall",
    snapshot.providerSelectionRecommendationShare,
    snapshot.providerSelectionRecommendationCount,
    snapshot.providerSelectionObservations,
  );

  for (const platform of snapshot.platforms) {
    const scopeKey = String(platform.platform);
    add("successful_observations", "platform", scopeKey, platform.successfulObservations);
    add("mention_count", "platform", scopeKey, platform.mentionCount);
    add("citation_count", "platform", scopeKey, platform.citationCount);
    add("recommendation_count", "platform", scopeKey, platform.recommendationCount);
    add(
      "mention_share",
      "platform",
      scopeKey,
      platform.mentionShare,
      platform.mentionCount,
      platform.successfulObservations,
    );
    add(
      "citation_share",
      "platform",
      scopeKey,
      platform.citationShare,
      platform.citationCount,
      platform.successfulObservations,
    );
    add(
      "recommendation_share",
      "platform",
      scopeKey,
      platform.recommendationShare,
      platform.recommendationCount,
      platform.successfulObservations,
    );
    add(
      "weighted_commercial_visibility_share",
      "platform",
      scopeKey,
      platform.weightedCommercialVisibilityShare,
    );
    add("visibility_index", "platform", scopeKey, platform.visibilityIndex);
    add("provider_selection_observations", "platform", scopeKey, platform.providerSelectionObservations);
    add(
      "provider_selection_recommendation_count",
      "platform",
      scopeKey,
      platform.providerSelectionRecommendationCount,
    );
    add(
      "provider_selection_recommendation_share",
      "platform",
      scopeKey,
      platform.providerSelectionRecommendationShare,
      platform.providerSelectionRecommendationCount,
      platform.providerSelectionObservations,
    );
  }

  return records;
}
