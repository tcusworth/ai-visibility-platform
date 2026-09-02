import type { Pool } from "pg";
import type { ObservationStatus } from "@ai-visibility/domain";

export interface ObservationAttemptRecord {
  id: string;
  observationId: string;
  attemptNumber: number;
  status: ObservationStatus;
  providerRequestId?: string;
  rawResponseRef?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface NewObservationAttempt {
  observationId: string;
  status: ObservationStatus;
  providerRequestId?: string;
  rawResponseRef?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

export class PostgresObservationAttemptStore {
  constructor(private readonly pool: Pool) {}

  async append(input: NewObservationAttempt): Promise<ObservationAttemptRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const observationResult = await client.query(
        `SELECT id FROM observations WHERE id=$1 FOR UPDATE`,
        [input.observationId],
      );
      if (!observationResult.rows[0]) {
        throw new Error(`Observation not found for attempt history: ${input.observationId}`);
      }

      const numberResult = await client.query(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
         FROM observation_attempts WHERE observation_id=$1`,
        [input.observationId],
      );
      const attemptNumber = Number(numberResult.rows[0].next_attempt_number);

      const result = await client.query(
        `INSERT INTO observation_attempts (
           observation_id, attempt_number, status, provider_request_id, raw_response_ref,
           error_code, error_message, started_at, completed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          input.observationId,
          attemptNumber,
          input.status,
          input.providerRequestId ?? null,
          input.rawResponseRef ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.startedAt ?? null,
          input.completedAt ?? null,
        ],
      );

      await client.query("COMMIT");
      return this.map(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(observationId: string): Promise<ObservationAttemptRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM observation_attempts
       WHERE observation_id=$1
       ORDER BY attempt_number`,
      [observationId],
    );
    return result.rows.map((row) => this.map(row));
  }

  private map(row: Record<string, any>): ObservationAttemptRecord {
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
}
