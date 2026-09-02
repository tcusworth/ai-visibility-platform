import type { PlatformRepository } from "@ai-visibility/database";
import type { BenchmarkRun, Observation, PlatformDefinition, PromptDefinition } from "@ai-visibility/domain";
import { planPendingObservations, type PlannedObservation } from "./index.js";

export interface ExecutionPlan {
  run: BenchmarkRun;
  prompts: PromptDefinition[];
  platforms: PlatformDefinition[];
  existingObservations: Observation[];
  pendingObservations: PlannedObservation[];
}

export async function buildExecutionPlan(
  repository: PlatformRepository,
  benchmarkRunId: string,
): Promise<ExecutionPlan> {
  const run = await repository.getBenchmarkRunById(benchmarkRunId);
  if (!run) throw new Error(`Benchmark run not found: ${benchmarkRunId}`);

  const definition = await repository.getBenchmarkDefinition(run.benchmarkDefinitionId);
  if (!definition) throw new Error(`Benchmark definition not found: ${run.benchmarkDefinitionId}`);

  const promptSet = await repository.getPromptSetVersion(definition.promptSetVersionId);
  if (!promptSet) throw new Error(`Prompt set not found: ${definition.promptSetVersionId}`);

  const prompts = promptSet.prompts.filter((prompt) => prompt.active);
  const platforms = definition.platforms.filter((platform) => platform.enabled);
  const existingObservations = await repository.listObservations(run.id);
  const pendingObservations = planPendingObservations({
    benchmarkRunKey: run.benchmarkRunKey,
    prompts,
    platforms,
    existingObservations,
  });

  const expected = prompts.length * platforms.length;
  if (expected !== run.expectedObservationCount) {
    throw new Error(
      `Run expects ${run.expectedObservationCount} observations but current definition resolves to ${expected}.`,
    );
  }

  return {
    run,
    prompts,
    platforms,
    existingObservations,
    pendingObservations,
  };
}
