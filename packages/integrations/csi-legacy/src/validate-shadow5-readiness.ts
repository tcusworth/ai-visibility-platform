import { Pool } from "pg";
import type { BenchmarkRun, Observation } from "@ai-visibility/domain";
import {
  dedupeObservations,
  evaluateCompleteness,
  planPendingObservations,
} from "@ai-visibility/engine";
import {
  buildRunMetricSnapshot,
  type VisibilityMethodologyProfile,
} from "@ai-visibility/scoring";
import { loadCsiShadow5Source, SHADOW5_PLATFORMS, SHADOW5_PROMPT_EXTERNAL_IDS } from "./shadow5-definition.js";
import { buildShadow5MetricSnapshotRecords } from "./shadow5-metrics.js";

const OFFLINE_RUN_KEY = "2099-01-01-shadow5-offline-validation";
const EXPECTED_OBSERVATIONS = SHADOW5_PROMPT_EXTERNAL_IDS.length * SHADOW5_PLATFORMS.length;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requireLocalDevDb(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, "");
  const port = url.port || "5432";
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || database !== "ai_visibility_dev" || port !== "55432") {
    throw new Error("Shadow5 offline validation is restricted to local ai_visibility_dev on port 55432.");
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function methodologyProfile(): VisibilityMethodologyProfile {
  return {
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
}

async function main(): Promise<void> {
  const connectionString = requireEnv("DATABASE_URL");
  requireLocalDevDb(connectionString);

  const pool = new Pool({ connectionString, ssl: false, max: 2 });
  try {
    const workspaceResult = await pool.query(
      `SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`,
    );
    const workspaceId = workspaceResult.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const source = await loadCsiShadow5Source(pool, workspaceId);
    assertEqual(source.prompts.length, SHADOW5_PROMPT_EXTERNAL_IDS.length, "Selected prompt count");
    assertEqual(source.platforms.length, SHADOW5_PLATFORMS.length, "Provider count");
    assertEqual(
      source.prompts.map((prompt) => prompt.externalPromptId).join(","),
      SHADOW5_PROMPT_EXTERNAL_IDS.join(","),
      "Selected external prompt IDs",
    );

    const initialPlan = planPendingObservations({
      benchmarkRunKey: OFFLINE_RUN_KEY,
      prompts: source.prompts,
      platforms: source.platforms,
      existingObservations: [],
    });
    assertEqual(initialPlan.length, EXPECTED_OBSERVATIONS, "Fresh pending logical observations");
    assertEqual(new Set(initialPlan.map((item) => item.observationKey)).size, EXPECTED_OBSERVATIONS, "Fresh unique logical keys");

    const scorePattern = [0, 1, 2, 4, 5] as const;
    const observations: Observation[] = initialPlan.map((item, index) => {
      const visibilityScore = scorePattern[index % scorePattern.length]!;
      const now = "2099-01-01T00:00:00.000Z";
      return {
        id: `offline-observation-${index + 1}`,
        workspaceId,
        benchmarkRunId: "offline-shadow5-run",
        benchmarkRunKey: OFFLINE_RUN_KEY,
        promptId: item.prompt.id,
        platform: item.platform.key,
        model: item.platform.model,
        status: "SUCCESS",
        answer: `Offline synthetic answer ${index + 1}`,
        sources: [],
        entities: [],
        targetMentioned: visibilityScore >= 1,
        targetCited: visibilityScore >= 2,
        targetRecommended: false,
        visibilityScore,
        weightedScore: visibilityScore * item.prompt.weight,
        scorerVersion: "offline-shadow5-synthetic-v1",
        createdAt: now,
        updatedAt: now,
      };
    });

    const duplicate = { ...observations[0]!, id: "offline-duplicate-success" };
    assertEqual(dedupeObservations([...observations, duplicate]).length, EXPECTED_OBSERVATIONS, "Duplicate logical observation collapse");

    const completeness = evaluateCompleteness({
      benchmarkRunKey: OFFLINE_RUN_KEY,
      prompts: source.prompts,
      platforms: source.platforms,
      observations,
    });
    assertEqual(completeness.expectedLogicalObservations, EXPECTED_OBSERVATIONS, "Expected logical observations");
    assertEqual(completeness.successfulLogicalObservations, EXPECTED_OBSERVATIONS, "Successful logical observations");
    assertEqual(completeness.failedLogicalObservations, 0, "Failed logical observations");
    assertEqual(completeness.missingObservationKeys.length, 0, "Missing logical observations");
    assertEqual(completeness.complete, true, "Completeness state");

    const resumePlan = planPendingObservations({
      benchmarkRunKey: OFFLINE_RUN_KEY,
      prompts: source.prompts,
      platforms: source.platforms,
      existingObservations: observations,
    });
    assertEqual(resumePlan.length, 0, "Resume pending observations after complete success");

    const snapshot = buildRunMetricSnapshot({
      observations,
      prompts: source.prompts,
      platformOrder: [...SHADOW5_PLATFORMS],
      profile: methodologyProfile(),
    });
    assertEqual(snapshot.successfulObservations, EXPECTED_OBSERVATIONS, "Snapshot successful observations");
    assertEqual(snapshot.platforms.length, SHADOW5_PLATFORMS.length, "Snapshot platform count");
    const roundedPlatformMean = snapshot.platforms.reduce((sum, platform) => sum + platform.visibilityIndex, 0) / snapshot.platforms.length;
    assertEqual(snapshot.visibilityIndex, Number(roundedPlatformMean.toFixed(10)), "Overall index is mean of rounded platform indices");

    const run: BenchmarkRun = {
      id: "offline-shadow5-run",
      workspaceId,
      benchmarkDefinitionId: source.sourceDefinitionId,
      benchmarkRunKey: OFFLINE_RUN_KEY,
      runDate: "2099-01-01",
      status: "finalizing",
      expectedPromptCount: SHADOW5_PROMPT_EXTERNAL_IDS.length,
      expectedPlatformCount: SHADOW5_PLATFORMS.length,
      expectedObservationCount: EXPECTED_OBSERVATIONS,
      successfulObservationCount: EXPECTED_OBSERVATIONS,
      failedObservationCount: 0,
      comparisonEligible: false,
      methodologyVersion: "csi-production-v1-shadow5",
      startedAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2099-01-01T00:00:00.000Z",
    };
    const records = buildShadow5MetricSnapshotRecords(run, snapshot, "2099-01-01T00:00:01.000Z");
    const metricKeys = records.map((record) => `${record.metricKey}|${record.scopeType}|${record.scopeKey}|${record.methodologyVersion}`);
    assertEqual(new Set(metricKeys).size, records.length, "Metric snapshot record uniqueness");

    console.log(`Shadow5 source definition: ${source.sourceDefinitionId}`);
    console.log(`Prompts: ${source.prompts.map((prompt) => prompt.externalPromptId).join(", ")}`);
    console.log(`Providers: ${source.platforms.map((platform) => `${platform.key}:${platform.model}`).join(", ")}`);
    console.log(`Expected logical observations: ${completeness.expectedLogicalObservations}`);
    console.log(`Successful logical observations: ${completeness.successfulLogicalObservations}`);
    console.log(`Resume pending observations: ${resumePlan.length}`);
    console.log(`Metric snapshot records prepared: ${records.length}`);
    console.log("Offline Shadow5 readiness validation passed.");
    console.log("Zero provider/scorer API calls. Zero database writes. Zero production changes.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
