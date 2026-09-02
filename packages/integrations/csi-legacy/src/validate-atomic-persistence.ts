import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Observation } from "@ai-visibility/domain";
import { PostgresObservationExecutionStore } from "@ai-visibility/database";

function requireLocalDevelopmentDatabase(connectionString: string): URL {
  const url = new URL(connectionString);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const databaseName = url.pathname.replace(/^\//, "");

  if (!localHosts.has(url.hostname) || databaseName !== "ai_visibility_dev") {
    throw new Error(
      "Atomic persistence validation is restricted to the local ai_visibility_dev database.",
    );
  }

  return url;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`${message}: passed`);
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to run this local database validation.");
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  requireLocalDevelopmentDatabase(connectionString);

  const pool = new Pool({
    connectionString,
    ssl: false,
    max: 4,
  });
  const executionStore = new PostgresObservationExecutionStore(pool);

  const temporaryRunId = randomUUID();
  const temporaryRunKey = `atomic-persistence-validation-${randomUUID()}`;
  let observationId: string | null = null;

  try {
    const workspaceResult = await pool.query(
      `SELECT id FROM workspaces WHERE slug='csi-dev' AND active=true LIMIT 1`,
    );
    const workspaceId = workspaceResult.rows[0]?.id as string | undefined;
    if (!workspaceId) throw new Error("Active csi-dev workspace not found.");

    const definitionResult = await pool.query(
      `SELECT id, prompt_set_version_id
       FROM benchmark_definitions
       WHERE workspace_id=$1 AND active=true
       ORDER BY id
       LIMIT 1`,
      [workspaceId],
    );
    const definition = definitionResult.rows[0] as
      | { id: string; prompt_set_version_id: string }
      | undefined;
    if (!definition) throw new Error("Active csi-dev benchmark definition not found.");

    const promptResult = await pool.query(
      `SELECT id FROM prompts
       WHERE prompt_set_version_id=$1 AND active=true
       ORDER BY external_prompt_id
       LIMIT 1`,
      [definition.prompt_set_version_id],
    );
    const promptId = promptResult.rows[0]?.id as string | undefined;
    if (!promptId) throw new Error("Active prompt not found for validation.");

    const platformResult = await pool.query(
      `SELECT platform_key, model
       FROM benchmark_platforms
       WHERE benchmark_definition_id=$1 AND enabled=true
       ORDER BY sort_order, platform_key
       LIMIT 1`,
      [definition.id],
    );
    const platform = platformResult.rows[0] as
      | { platform_key: string; model: string }
      | undefined;
    if (!platform) throw new Error("Enabled platform not found for validation.");

    await pool.query(
      `INSERT INTO benchmark_runs (
         id, workspace_id, benchmark_definition_id, benchmark_run_key, run_date, status,
         expected_prompt_count, expected_platform_count, expected_observation_count,
         successful_observation_count, failed_observation_count, comparison_eligible,
         methodology_version
       ) VALUES ($1,$2,$3,$4,CURRENT_DATE,'running',1,1,1,0,0,false,'atomic-validation-v1')`,
      [temporaryRunId, workspaceId, definition.id, temporaryRunKey],
    );

    const now = new Date().toISOString();
    const initialObservationUuid = randomUUID();
    const failedObservation: Observation = {
      id: initialObservationUuid,
      workspaceId,
      benchmarkRunId: temporaryRunId,
      benchmarkRunKey: temporaryRunKey,
      promptId,
      platform: platform.platform_key,
      model: platform.model,
      status: "FAILED",
      errorCode: "VALIDATION_FAILURE",
      errorMessage: "Synthetic first attempt failure.",
      sources: [],
      entities: [],
      scorerVersion: "atomic-validation-v1",
      createdAt: now,
      updatedAt: now,
    };

    const first = await executionStore.persist({
      observation: failedObservation,
      attempt: {
        status: "FAILED",
        providerRequestId: "validation-attempt-1",
        errorCode: "VALIDATION_FAILURE",
        errorMessage: "Synthetic first attempt failure.",
        startedAt: now,
        completedAt: now,
      },
    });
    observationId = first.observationId;

    assert(first.attempt.attemptNumber === 1, "Attempt 1 assigned sequence number 1");
    assert(first.attempt.status === "FAILED", "Attempt 1 persisted as FAILED");

    const successTime = new Date().toISOString();
    const successfulObservation: Observation = {
      ...failedObservation,
      id: randomUUID(),
      status: "SUCCESS",
      answer: "Synthetic successful retry for atomic persistence validation.",
      sources: [
        {
          url: "https://csi-automation.com/atomic-persistence-validation",
          domain: "csi-automation.com",
          ownedByTarget: true,
        },
      ],
      entities: [
        {
          canonicalName: "Collaborative Systems Integration",
          type: "target",
        },
      ],
      targetMentioned: true,
      targetCited: true,
      targetRecommended: false,
      targetPositioning: "Synthetic validation positioning.",
      visibilityScore: 3,
      weightedScore: 9,
      scorerVersion: "atomic-validation-v2",
      updatedAt: successTime,
    };
    delete successfulObservation.errorCode;
    delete successfulObservation.errorMessage;

    const second = await executionStore.persist({
      observation: successfulObservation,
      attempt: {
        status: "SUCCESS",
        providerRequestId: "validation-attempt-2",
        rawResponseRef: "synthetic://atomic-persistence-validation",
        startedAt: successTime,
        completedAt: successTime,
      },
    });

    assert(second.observationId === observationId, "Retry reused the canonical observation row");
    assert(second.attempt.attemptNumber === 2, "Attempt 2 assigned sequence number 2");
    assert(second.attempt.status === "SUCCESS", "Attempt 2 persisted as SUCCESS");

    const canonicalResult = await pool.query(
      `SELECT id, status, answer_text, error_code, error_message, scorer_version
       FROM observations
       WHERE benchmark_run_id=$1 AND prompt_id=$2 AND platform_key=$3`,
      [temporaryRunId, promptId, platform.platform_key],
    );
    assert(canonicalResult.rowCount === 1, "Exactly one canonical observation exists");
    const canonical = canonicalResult.rows[0];
    assert(canonical.id === observationId, "Canonical observation ID stayed stable across retry");
    assert(canonical.status === "SUCCESS", "Canonical observation reflects the successful retry");
    assert(canonical.error_code === null && canonical.error_message === null, "Retry cleared prior failure fields");
    assert(canonical.scorer_version === "atomic-validation-v2", "Canonical scorer version was updated");

    const attemptResult = await pool.query(
      `SELECT attempt_number, status FROM observation_attempts
       WHERE observation_id=$1 ORDER BY attempt_number`,
      [observationId],
    );
    assert(attemptResult.rowCount === 2, "Exactly two attempt-history rows exist");
    assert(
      attemptResult.rows[0]?.attempt_number === 1 && attemptResult.rows[0]?.status === "FAILED",
      "Attempt history preserved FAILED attempt 1",
    );
    assert(
      attemptResult.rows[1]?.attempt_number === 2 && attemptResult.rows[1]?.status === "SUCCESS",
      "Attempt history preserved SUCCESS attempt 2",
    );

    const sourceResult = await pool.query(
      `SELECT url, domain, owned_by_target FROM observation_sources WHERE observation_id=$1`,
      [observationId],
    );
    assert(sourceResult.rowCount === 1, "Successful retry replaced canonical sources atomically");

    const entityResult = await pool.query(
      `SELECT canonical_name, entity_type FROM observation_entities WHERE observation_id=$1`,
      [observationId],
    );
    assert(entityResult.rowCount === 1, "Successful retry replaced canonical entities atomically");

    console.log("Atomic observation + attempt persistence validation passed.");
    console.log("Only the local ai_visibility_dev PostgreSQL database was used.");
    console.log("No model, provider, scorer, n8n, or CSI production calls were made.");
  } finally {
    await pool.query(`DELETE FROM benchmark_runs WHERE id=$1`, [temporaryRunId]).catch(() => undefined);

    if (observationId) {
      const leftovers = await pool.query(
        `SELECT COUNT(*)::int AS count FROM observations WHERE id=$1`,
        [observationId],
      );
      if (Number(leftovers.rows[0]?.count ?? 0) !== 0) {
        await pool.end();
        throw new Error("Temporary validation observation was not cleaned up.");
      }
    }

    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
