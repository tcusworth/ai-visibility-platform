import type { BenchmarkRun } from "@ai-visibility/domain";
import type { PlatformRepository } from "@ai-visibility/database";
import { buildExecutionPlan } from "./execution-planner.js";
import { evaluateCompleteness } from "./planning.js";

export interface ReconcileRunResult {
  run: BenchmarkRun;
  complete: boolean;
  successfulLogicalObservations: number;
  failedLogicalObservations: number;
  missingLogicalObservations: number;
}

export async function reconcileBenchmarkRun(
  repository: PlatformRepository,
  benchmarkRunId: string,
  now = new Date().toISOString(),
): Promise<ReconcileRunResult> {
  const plan = await buildExecutionPlan(repository, benchmarkRunId);
  const completeness = evaluateCompleteness({
    benchmarkRunKey: plan.run.benchmarkRunKey,
    prompts: plan.prompts,
    platforms: plan.platforms,
    observations: plan.existingObservations,
  });

  if (completeness.expectedLogicalObservations !== plan.run.expectedObservationCount) {
    throw new Error(
      `Run expectation mismatch: lifecycle calculated ${completeness.expectedLogicalObservations} observations but run expects ${plan.run.expectedObservationCount}.`,
    );
  }

  const nextStatus = completeness.complete ? "finalizing" : "running";
  const updated: BenchmarkRun = {
    ...plan.run,
    status: nextStatus,
    successfulObservationCount: completeness.successfulLogicalObservations,
    failedObservationCount: completeness.failedLogicalObservations,
    comparisonEligible: false,
    ...(!plan.run.startedAt ? { startedAt: now } : {}),
  };

  await repository.updateBenchmarkRun(updated);

  return {
    run: updated,
    complete: completeness.complete,
    successfulLogicalObservations: completeness.successfulLogicalObservations,
    failedLogicalObservations: completeness.failedLogicalObservations,
    missingLogicalObservations: completeness.missingObservationKeys.length,
  };
}
