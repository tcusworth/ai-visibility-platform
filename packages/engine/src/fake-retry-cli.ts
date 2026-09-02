import process from "node:process";
import { randomUUID } from "node:crypto";
import { PostgresPlatformRepository } from "@ai-visibility/database";
import type { Observation } from "@ai-visibility/domain";
import { FakeProvider } from "@ai-visibility/providers";
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
    const before = await buildExecutionPlan(repository, benchmarkRunId);
    const item = before.pendingObservations[0];
    if (!item) throw new Error("No pending observation is available for the retry test.");

    const failedAt = new Date().toISOString();
    const failed: Observation = {
      id: randomUUID(),
      workspaceId: before.run.workspaceId,
      benchmarkRunId: before.run.id,
      benchmarkRunKey: before.run.benchmarkRunKey,
      promptId: item.prompt.id,
      platform: item.platform.key,
      model: item.platform.model,
      status: "FAILED",
      errorCode: "FAKE_RETRY_TEST",
      errorMessage: "Intentional fake failure used to validate retry semantics.",
      sources: [],
      entities: [],
      scorerVersion: "fake-unscored-v1",
      createdAt: failedAt,
      updatedAt: failedAt,
    };
    await repository.upsertObservation(failed);

    const afterFailure = await buildExecutionPlan(repository, benchmarkRunId);
    const stillPending = afterFailure.pendingObservations.some((candidate) => candidate.observationKey === item.observationKey);
    if (!stillPending) throw new Error("Retry validation failed: FAILED observation was incorrectly removed from the pending plan.");

    const provider = new FakeProvider(item.platform.key);
    const response = await provider.generate({
      platform: item.platform.key,
      model: item.platform.model,
      prompt: item.prompt.text,
    });
    const successAt = new Date().toISOString();
    const success: Observation = {
      id: failed.id,
      workspaceId: failed.workspaceId,
      benchmarkRunId: failed.benchmarkRunId,
      benchmarkRunKey: failed.benchmarkRunKey,
      promptId: failed.promptId,
      platform: failed.platform,
      model: response.model,
      status: "SUCCESS",
      answer: response.answer,
      sources: [],
      entities: [],
      scorerVersion: failed.scorerVersion,
      createdAt: failed.createdAt,
      updatedAt: successAt,
    };
    await repository.upsertObservation(success);

    const afterSuccess = await buildExecutionPlan(repository, benchmarkRunId);
    const pendingAfterSuccess = afterSuccess.pendingObservations.some((candidate) => candidate.observationKey === item.observationKey);
    if (pendingAfterSuccess) throw new Error("Retry validation failed: SUCCESS observation remained in the pending plan.");

    console.log(`Run key: ${before.run.benchmarkRunKey}`);
    console.log(`Test observation: ${item.observationKey}`);
    console.log(`Pending before test: ${before.pendingObservations.length}`);
    console.log("Intentional FAILED observation written: 1");
    console.log(`FAILED remained retryable: ${stillPending ? "yes" : "no"}`);
    console.log("FAILED observation replaced with fake SUCCESS: 1");
    console.log(`SUCCESS removed from pending plan: ${pendingAfterSuccess ? "no" : "yes"}`);
    console.log(`Existing observations after test: ${afterSuccess.existingObservations.length}`);
    console.log(`Pending observations after test: ${afterSuccess.pendingObservations.length}`);
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
