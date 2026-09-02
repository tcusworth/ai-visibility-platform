import process from "node:process";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import { buildExecutionPlan } from "./execution-planner.js";

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
    const plan = await buildExecutionPlan(repository, benchmarkRunId);
    console.log(`Run key: ${plan.run.benchmarkRunKey}`);
    console.log(`Status: ${plan.run.status}`);
    console.log(`Active prompts: ${plan.prompts.length}`);
    console.log(`Enabled platforms: ${plan.platforms.length}`);
    console.log(`Existing observations: ${plan.existingObservations.length}`);
    console.log(`Pending observations: ${plan.pendingObservations.length}`);
    console.log(`Expected observations: ${plan.run.expectedObservationCount}`);
    console.log("No provider/model calls were made and no observations were written.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
