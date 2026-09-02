import process from "node:process";
import { randomUUID } from "node:crypto";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import type { Observation } from "@ai-visibility/domain";
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
    const before = await buildExecutionPlan(repository, benchmarkRunId);
    const selected = before.pendingObservations.slice(0, limit);

    const registry = new ProviderRegistry();
    for (const platform of before.platforms) registry.register(new FakeProvider(platform.key));

    let written = 0;
    for (const item of selected) {
      const provider = registry.get(item.platform.key);
      const response = await provider.generate({
        platform: item.platform.key,
        model: item.platform.model,
        prompt: item.prompt.text,
      });

      const now = new Date().toISOString();
      const observation: Observation = {
        id: randomUUID(),
        workspaceId: before.run.workspaceId,
        benchmarkRunId: before.run.id,
        benchmarkRunKey: before.run.benchmarkRunKey,
        promptId: item.prompt.id,
        platform: item.platform.key,
        model: response.model,
        status: "SUCCESS",
        answer: response.answer,
        sources: [],
        entities: [],
        scorerVersion: "fake-unscored-v1",
        createdAt: now,
        updatedAt: now,
      };

      await repository.upsertObservation(observation);
      written += 1;
    }

    const after = await buildExecutionPlan(repository, benchmarkRunId);

    console.log(`Run key: ${before.run.benchmarkRunKey}`);
    console.log(`Pending before fake persistence: ${before.pendingObservations.length}`);
    console.log(`Fake SUCCESS observations written: ${written}`);
    console.log(`Existing observations after write: ${after.existingObservations.length}`);
    console.log(`Pending observations after write: ${after.pendingObservations.length}`);
    console.log(`Expected observations: ${before.run.expectedObservationCount}`);
    console.log("No live provider/model API calls were made.");
    console.log("Benchmark run status/counters were not changed.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
