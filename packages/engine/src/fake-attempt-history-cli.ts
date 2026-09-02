import process from "node:process";
import { randomUUID } from "node:crypto";
import { PostgresObservationAttemptStore, PostgresPlatformRepository } from "@ai-visibility/database";
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
  const attempts = new PostgresObservationAttemptStore(repository.pool);

  try {
    const before = await buildExecutionPlan(repository, benchmarkRunId);
    const item = before.pendingObservations[0];
    if (!item) throw new Error("No pending observation is available for the attempt-history test.");

    const failedAt = new Date().toISOString();
    const observationId = randomUUID();
    const failed: Observation = {
      id: observationId,
      workspaceId: before.run.workspaceId,
      benchmarkRunId: before.run.id,
      benchmarkRunKey: before.run.benchmarkRunKey,
      promptId: item.prompt.id,
      platform: item.platform.key,
      model: item.platform.model,
      status: "FAILED",
      errorCode: "FAKE_ATTEMPT_HISTORY_TEST",
      errorMessage: "Intentional fake failure used to validate attempt history.",
      sources: [],
      entities: [],
      scorerVersion: "fake-unscored-v1",
      createdAt: failedAt,
      updatedAt: failedAt,
    };
    await repository.upsertObservation(failed);
    await attempts.append({
      observationId,
      status: "FAILED",
      providerRequestId: `fake-failed:${String(item.platform.key)}`,
      ...(failed.errorCode ? { errorCode: failed.errorCode } : {}),
      ...(failed.errorMessage ? { errorMessage: failed.errorMessage } : {}),
      startedAt: failedAt,
      completedAt: failedAt,
    });

    const afterFailure = await buildExecutionPlan(repository, benchmarkRunId);
    const retryable = afterFailure.pendingObservations.some((candidate) => candidate.observationKey === item.observationKey);
    if (!retryable) throw new Error("Attempt-history validation failed: FAILED observation was not retryable.");

    const provider = new FakeProvider(item.platform.key);
    const successStartedAt = new Date().toISOString();
    const response = await provider.generate({
      platform: item.platform.key,
      model: item.platform.model,
      prompt: item.prompt.text,
    });
    const successCompletedAt = new Date().toISOString();
    const success: Observation = {
      id: observationId,
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
      updatedAt: successCompletedAt,
    };
    await repository.upsertObservation(success);
    await attempts.append({
      observationId,
      status: "SUCCESS",
      ...(response.rawProviderId ? { providerRequestId: response.rawProviderId } : {}),
      startedAt: successStartedAt,
      completedAt: successCompletedAt,
    });

    const history = await attempts.list(observationId);
    if (history.length !== 2) {
      throw new Error(`Attempt-history validation failed: expected 2 attempts, found ${history.length}.`);
    }
    if (history[0]?.status !== "FAILED" || history[0].attemptNumber !== 1) {
      throw new Error("Attempt-history validation failed: attempt 1 is not FAILED.");
    }
    if (history[1]?.status !== "SUCCESS" || history[1].attemptNumber !== 2) {
      throw new Error("Attempt-history validation failed: attempt 2 is not SUCCESS.");
    }

    const afterSuccess = await buildExecutionPlan(repository, benchmarkRunId);
    const stillPending = afterSuccess.pendingObservations.some((candidate) => candidate.observationKey === item.observationKey);
    if (stillPending) throw new Error("Attempt-history validation failed: successful retry remained pending.");

    console.log(`Run key: ${before.run.benchmarkRunKey}`);
    console.log(`Test observation: ${item.observationKey}`);
    console.log(`Pending before test: ${before.pendingObservations.length}`);
    console.log("Attempt 1 persisted: FAILED");
    console.log(`FAILED remained retryable: ${retryable ? "yes" : "no"}`);
    console.log("Attempt 2 persisted: SUCCESS");
    console.log(`Attempt history rows: ${history.length}`);
    console.log(`Attempt sequence: ${history.map((attempt) => `${attempt.attemptNumber}:${attempt.status}`).join(", ")}`);
    console.log(`SUCCESS removed from pending plan: ${stillPending ? "no" : "yes"}`);
    console.log(`Existing observations after test: ${afterSuccess.existingObservations.length}`);
    console.log(`Pending observations after test: ${afterSuccess.pendingObservations.length}`);
    console.log("No live provider/model API calls were made.");
    console.log("Benchmark run status/counters were not reconciled by this command.");
  } finally {
    await repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
