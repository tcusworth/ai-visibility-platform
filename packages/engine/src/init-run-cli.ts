import process from "node:process";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import { initializeBenchmarkRun } from "./run-initializer.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Load .env before running this command.");

  const workspaceSlug = process.env.BENCHMARK_WORKSPACE_SLUG ?? "csi-dev";
  const benchmarkDefinitionId = process.env.BENCHMARK_DEFINITION_ID;
  if (!benchmarkDefinitionId) throw new Error("BENCHMARK_DEFINITION_ID is required.");

  const runDate = process.env.BENCHMARK_RUN_DATE ?? new Date().toISOString().slice(0, 10);
  const benchmarkRunKey = process.env.BENCHMARK_RUN_KEY ?? `${runDate}-shadow-v1`;
  const methodologyVersion = process.env.BENCHMARK_METHODOLOGY_VERSION ?? "csi-production-v1";

  const repository = new PostgresPlatformRepository({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
  });

  try {
    const result = await initializeBenchmarkRun(repository, {
      workspaceSlug,
      benchmarkDefinitionId,
      benchmarkRunKey,
      runDate,
      methodologyVersion,
    });

    console.log(result.created ? "Created queued benchmark run." : "Benchmark run already exists; no duplicate created.");
    console.log(`Run ID: ${result.run.id}`);
    console.log(`Run key: ${result.run.benchmarkRunKey}`);
    console.log(`Status: ${result.run.status}`);
    console.log(`Expected prompts: ${result.run.expectedPromptCount}`);
    console.log(`Expected platforms: ${result.run.expectedPlatformCount}`);
    console.log(`Expected observations: ${result.run.expectedObservationCount}`);
    console.log(`Comparison eligible: ${result.run.comparisonEligible}`);
    console.log("No provider/model calls were made.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
