import type { Observation } from "@ai-visibility/domain";
import type { Pool, PoolClient } from "pg";
import type { NewObservationAttempt, ObservationAttemptRecord } from "./attempts.js";

export interface PersistObservationExecutionInput {
  observation: Observation;
  attempt: Omit<NewObservationAttempt, "observationId">;
}

export interface PersistObservationExecutionResult {
  observationId: string;
  attempt: ObservationAttemptRecord;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function mapAttempt(row: Record<string, any>): ObservationAttemptRecord {
  return {
    id: row.id,
    observationId: row.observation_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    ...(row.raw_response_ref ? { rawResponseRef: row.raw_response_ref } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    createdAt: iso(row.created_at),
  };
}

async function upsertObservationWithChildren(client: PoolClient, observation: Observation): Promise<string> {
  await client.query(
    `INSERT INTO observations (
       id, workspace_id, benchmark_run_id, benchmark_run_key, prompt_id, platform_key, model,
       status, answer_text, error_code, error_message, target_mentioned, target_cited,
       target_recommended, target_positioning, visibility_score, weighted_score, scorer_version,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (benchmark_run_id, prompt_id, platform_key) DO UPDATE SET
       model=EXCLUDED.model, status=EXCLUDED.status, answer_text=EXCLUDED.answer_text,
       error_code=EXCLUDED.error_code, error_message=EXCLUDED.error_message,
       target_mentioned=EXCLUDED.target_mentioned, target_cited=EXCLUDED.target_cited,
       target_recommended=EXCLUDED.target_recommended, target_positioning=EXCLUDED.target_positioning,
       visibility_score=EXCLUDED.visibility_score, weighted_score=EXCLUDED.weighted_score,
       scorer_version=EXCLUDED.scorer_version, updated_at=EXCLUDED.updated_at`,
    [
      observation.id, observation.workspaceId, observation.benchmarkRunId, observation.benchmarkRunKey,
      observation.promptId, observation.platform, observation.model, observation.status,
      observation.answer ?? null, observation.errorCode ?? null, observation.errorMessage ?? null,
      observation.targetMentioned ?? null, observation.targetCited ?? null, observation.targetRecommended ?? null,
      observation.targetPositioning ?? null, observation.visibilityScore ?? null, observation.weightedScore ?? null,
      observation.scorerVersion, observation.createdAt, observation.updatedAt,
    ],
  );

  const idResult = await client.query(
    `SELECT id FROM observations
     WHERE benchmark_run_id=$1 AND prompt_id=$2 AND platform_key=$3
     FOR UPDATE`,
    [observation.benchmarkRunId, observation.promptId, observation.platform],
  );
  const row = idResult.rows[0];
  if (!row) throw new Error("Observation upsert did not produce a canonical observation row.");
  const observationId = row.id as string;

  await client.query(`DELETE FROM observation_sources WHERE observation_id=$1`, [observationId]);
  for (let index = 0; index < observation.sources.length; index += 1) {
    const source = observation.sources[index]!;
    await client.query(
      `INSERT INTO observation_sources (observation_id, url, domain, owned_by_target, source_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [observationId, source.url, source.domain, source.ownedByTarget, index],
    );
  }

  await client.query(`DELETE FROM observation_entities WHERE observation_id=$1`, [observationId]);
  for (const entity of observation.entities) {
    await client.query(
      `INSERT INTO observation_entities (observation_id, entity_type, canonical_name)
       VALUES ($1,$2,$3)`,
      [observationId, entity.type, entity.canonicalName],
    );
  }

  return observationId;
}

export class PostgresObservationExecutionStore {
  constructor(private readonly pool: Pool) {}

  async persist(input: PersistObservationExecutionInput): Promise<PersistObservationExecutionResult> {
    if (input.attempt.status !== input.observation.status) {
      throw new Error(
        `Attempt status ${input.attempt.status} must match canonical observation status ${input.observation.status}.`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const observationId = await upsertObservationWithChildren(client, input.observation);

      const numberResult = await client.query(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
         FROM observation_attempts WHERE observation_id=$1`,
        [observationId],
      );
      const attemptNumber = Number(numberResult.rows[0].next_attempt_number);

      const attemptResult = await client.query(
        `INSERT INTO observation_attempts (
           observation_id, attempt_number, status, provider_request_id, raw_response_ref,
           error_code, error_message, started_at, completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          observationId,
          attemptNumber,
          input.attempt.status,
          input.attempt.providerRequestId ?? null,
          input.attempt.rawResponseRef ?? null,
          input.attempt.errorCode ?? null,
          input.attempt.errorMessage ?? null,
          input.attempt.startedAt ?? null,
          input.attempt.completedAt ?? null,
        ],
      );

      await client.query("COMMIT");
      return {
        observationId,
        attempt: mapAttempt(attemptResult.rows[0]),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
