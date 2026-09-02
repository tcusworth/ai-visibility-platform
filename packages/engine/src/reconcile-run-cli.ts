import process from "node:process";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import { reconcileBenchmarkRun } from "./run-lifecycle.js";

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
    const result = await reconcileBenchmarkRun(repository, benchmarkRunId);
    console.log(`Run key: ${result.run.benchmarkRunKey}`);
    console.log(`Run status: ${result.run.status}`);
    console.log(`Successful observations: ${result.successfulLogicalObservations}`);
    console.log(`Failed observations: ${result.failedLogicalObservations}`);
    console.log(`Missing observations: ${result.missingLogicalObservations}`);
    console.log(`Comparison eligible: ${result.run.comparisonEligible}`);
    console.log(`Started at set: ${result.run.startedAt ? "yes" : "no"}`);
    console.log(`Structurally complete: ${result.complete ? "yes" : "no"}`);
    console.log("No provider/model API calls were made.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
