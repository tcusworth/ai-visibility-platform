import { randomUUID } from "node:crypto";
import type { BenchmarkRun } from "@ai-visibility/domain";
import type { PlatformRepository } from "@ai-visibility/database";

export interface InitializeBenchmarkRunInput {
  workspaceSlug: string;
  benchmarkDefinitionId: string;
  benchmarkRunKey: string;
  runDate: string;
  methodologyVersion: string;
  now?: string;
}

export interface InitializeBenchmarkRunResult {
  run: BenchmarkRun;
  created: boolean;
}

export async function initializeBenchmarkRun(
  repository: PlatformRepository,
  input: InitializeBenchmarkRunInput,
): Promise<InitializeBenchmarkRunResult> {
  const workspace = await repository.getWorkspaceBySlug(input.workspaceSlug);
  if (!workspace) throw new Error(`Workspace not found: ${input.workspaceSlug}`);
  if (!workspace.active) throw new Error(`Workspace is inactive: ${input.workspaceSlug}`);

  const definition = await repository.getBenchmarkDefinition(input.benchmarkDefinitionId);
  if (!definition) throw new Error(`Benchmark definition not found: ${input.benchmarkDefinitionId}`);
  if (!definition.active) throw new Error(`Benchmark definition is inactive: ${input.benchmarkDefinitionId}`);
  if (definition.workspaceId !== workspace.id) {
    throw new Error(`Benchmark definition ${definition.id} does not belong to workspace ${workspace.slug}`);
  }

  const existing = await repository.getBenchmarkRunByKey(workspace.id, input.benchmarkRunKey);
  if (existing) return { run: existing, created: false };

  const promptSet = await repository.getPromptSetVersion(definition.promptSetVersionId);
  if (!promptSet) throw new Error(`Prompt set not found: ${definition.promptSetVersionId}`);

  const activePromptCount = promptSet.prompts.filter((prompt) => prompt.active).length;
  const enabledPlatformCount = definition.platforms.filter((platform) => platform.enabled).length;

  if (activePromptCount !== definition.expectedPromptCount) {
    throw new Error(
      `Benchmark definition expects ${definition.expectedPromptCount} active prompts but prompt set contains ${activePromptCount}.`,
    );
  }
  if (enabledPlatformCount === 0) throw new Error("Benchmark definition has no enabled platforms.");

  const createdAt = input.now ?? new Date().toISOString();
  const run: BenchmarkRun = {
    id: randomUUID(),
    workspaceId: workspace.id,
    benchmarkDefinitionId: definition.id,
    benchmarkRunKey: input.benchmarkRunKey,
    runDate: input.runDate,
    status: "queued",
    expectedPromptCount: activePromptCount,
    expectedPlatformCount: enabledPlatformCount,
    expectedObservationCount: activePromptCount * enabledPlatformCount,
    successfulObservationCount: 0,
    failedObservationCount: 0,
    comparisonEligible: false,
    methodologyVersion: input.methodologyVersion,
    createdAt,
  };

  await repository.createBenchmarkRun(run);
  return { run, created: true };
}
