import process from "node:process";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import { DeterministicFakeScorer, applyScoringResult } from "@ai-visibility/scoring";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Load .env before running this command.");

  const benchmarkRunId = process.env.BENCHMARK_RUN_ID;
  if (!benchmarkRunId) throw new Error("BENCHMARK_RUN_ID is required.");

  const repository = new PostgresPlatformRepository({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
  });

  try {
    const run = await repository.getBenchmarkRunById(benchmarkRunId);
    if (!run) throw new Error(`Benchmark run not found: ${benchmarkRunId}`);

    const definition = await repository.getBenchmarkDefinition(run.benchmarkDefinitionId);
    if (!definition) throw new Error(`Benchmark definition not found: ${run.benchmarkDefinitionId}`);

    const [promptSet, target, observations] = await Promise.all([
      repository.getPromptSetVersion(definition.promptSetVersionId),
      repository.getTargetEntity(definition.targetEntityId),
      repository.listObservations(run.id),
    ]);
    if (!promptSet) throw new Error(`Prompt set not found: ${definition.promptSetVersionId}`);
    if (!target) throw new Error(`Target entity not found: ${definition.targetEntityId}`);

    const observation = observations.find((candidate) => candidate.status === "SUCCESS" && candidate.scorerVersion === "fake-unscored-v1");
    if (!observation) throw new Error("No unscored fake SUCCESS observation is available.");

    const prompt = promptSet.prompts.find((candidate) => candidate.id === observation.promptId);
    if (!prompt) throw new Error(`Prompt not found for observation: ${observation.promptId}`);

    const scorer = new DeterministicFakeScorer();
    const result = await scorer.score({ observation, prompt, target });
    const scored = applyScoringResult(observation, result, new Date().toISOString());
    await repository.upsertObservation(scored);

    const persisted = await repository.getObservation(run.id, observation.promptId, observation.platform);
    if (!persisted) throw new Error("Scored observation could not be reloaded.");
    if (persisted.scorerVersion !== scorer.version) throw new Error("Scorer version was not persisted.");
    if (persisted.visibilityScore !== result.visibilityScore) throw new Error("Visibility score was not persisted.");
    if (persisted.weightedScore !== result.weightedScore) throw new Error("Weighted score was not persisted.");
    if (persisted.targetMentioned !== result.targetMentioned) throw new Error("Target mention result was not persisted.");
    if (persisted.targetCited !== result.targetCited) throw new Error("Target citation result was not persisted.");
    if (persisted.targetRecommended !== result.targetRecommended) throw new Error("Target recommendation result was not persisted.");

    console.log(`Run key: ${run.benchmarkRunKey}`);
    console.log(`Observation: ${run.benchmarkRunKey}|${prompt.id}|${observation.platform}`);
    console.log(`Prompt external ID: ${prompt.externalPromptId}`);
    console.log(`Scorer version: ${persisted.scorerVersion}`);
    console.log(`Target mentioned: ${String(persisted.targetMentioned)}`);
    console.log(`Target cited: ${String(persisted.targetCited)}`);
    console.log(`Target recommended: ${String(persisted.targetRecommended)}`);
    console.log(`Visibility score: ${persisted.visibilityScore}`);
    console.log(`Weighted score: ${persisted.weightedScore}`);
    console.log("Scored observation persisted and reloaded successfully.");
    console.log("No live provider/model/scorer API calls were made.");
    console.log("Benchmark run status/counters were not changed.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
