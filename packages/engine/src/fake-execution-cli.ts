import process from "node:process";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import { FakeProvider, ProviderRegistry } from "@ai-visibility/providers";
import { buildExecutionPlan } from "./execution-planner.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Load .env before running this command.");

  const benchmarkRunId = process.env.BENCHMARK_RUN_ID;
  if (!benchmarkRunId) throw new Error("BENCHMARK_RUN_ID is required.");

  const limit = Number(process.env.FAKE_EXECUTION_LIMIT ?? "4");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("FAKE_EXECUTION_LIMIT must be a positive integer.");

  const repository = new PostgresPlatformRepository({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
  });

  try {
    const plan = await buildExecutionPlan(repository, benchmarkRunId);
    const selected = plan.pendingObservations.slice(0, limit);

    const registry = new ProviderRegistry();
    for (const platform of plan.platforms) registry.register(new FakeProvider(platform.key));

    const results = [];
    for (const item of selected) {
      const provider = registry.get(item.platform.key);
      const response = await provider.generate({
        platform: item.platform.key,
        model: item.platform.model,
        prompt: item.prompt.text,
      });
      results.push({
        observationKey: item.observationKey,
        platform: item.platform.key,
        model: response.model,
        answerLength: response.answer.length,
      });
    }

    console.log(`Run key: ${plan.run.benchmarkRunKey}`);
    console.log(`Pending before fake execution: ${plan.pendingObservations.length}`);
    console.log(`Fake executions completed in memory: ${results.length}`);
    for (const result of results) {
      console.log(`${result.observationKey} | ${String(result.platform)} | ${result.model} | answer chars ${result.answerLength}`);
    }
    console.log("No live provider/model API calls were made.");
    console.log("No observations or run-state changes were written to PostgreSQL.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
