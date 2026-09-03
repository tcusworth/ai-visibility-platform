import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  PostgresObservationExecutionStore,
  PostgresPlatformRepository,
} from "@ai-visibility/database";
import {
  BenchmarkObservationExecutionService,
  buildExecutionPlan,
  reconcileBenchmarkRun,
} from "@ai-visibility/engine";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { BenchmarkRun } from "@ai-visibility/domain";
import {
  buildRunMetricSnapshot,
  type VisibilityMethodologyProfile,
  type VisibilityScorerPromptProfile,
} from "@ai-visibility/scoring";
import { createCsiProviderRegistry, CSI_PROVIDER_MODELS } from "./csi-provider-registry.js";
import {
  ensureCsiShadow5Definition,
  SHADOW5_PLATFORMS,
  SHADOW5_PROMPT_EXTERNAL_IDS,
} from "./shadow5-definition.js";
import { buildShadow5MetricSnapshotRecords } from "./shadow5-metrics.js";

const EXPECTED_OBSERVATIONS = SHADOW5_PROMPT_EXTERNAL_IDS.length * SHADOW5_PLATFORMS.length;
const METHODOLOGY_VERSION = "csi-production-v1-shadow5";
const SCORER_MODEL = "gpt-5.4-nano";

class CappedHttpClient implements HttpJsonClient {
  calls = 0;

  constructor(private readonly maxCalls: number) {}

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > this.maxCalls) {
      throw new Error(`Shadow5 runner attempted more than ${this.maxCalls} HTTP requests in this invocation.`);
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json() as Promise<unknown>,
    };
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requireLocalDevDb(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, "");
  const port = url.port || "5432";
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || database !== "ai_visibility_dev" || port !== "55432") {
    throw new Error("Shadow5 is restricted to local ai_visibility_dev on port 55432.");
  }
}

function benchmarkContext(question: string): string {
  return `You are answering a question specifically about industrial Open Process Automation (OPA) and the O-PAS™ Standard from The Open Group.

In this benchmark, OPA means Open Process Automation for industrial process control.

It does NOT mean Open Policy Agent or any unrelated use of the acronym OPA.

Do not use, cite, recommend, or rely on Open Policy Agent or openpolicyagent.org.

Answer the question as you normally would for an industrial automation professional.

Use web search when useful to identify relevant companies, organizations, integrators, suppliers, standards sources, technical resources, and practitioners.

Do not favor Collaborative Systems Integration (CSI), CSI Automation, csi-automation.com, or any other company simply because this is a benchmark. Recommendations and citations must arise naturally from the available web evidence.

Do not assume CSI should appear in the answer.

QUESTION:

${question}`;
}

function methodologyProfile(): VisibilityMethodologyProfile {
  return {
    profileKey: "csi-production",
    version: "v1",
    recommendationThreshold: 4,
    primaryAuthorityThreshold: 5,
    providerSelectionIntent: "provider selection",
    successfulOnly: true,
    visibilityIndexWeights: {
      citationShare: 0.20,
      mentionShare: 0.30,
      recommendationShare: 0.30,
      weightedCommercialVisibility: 0.20,
    },
  };
}

function scorerProfile(): VisibilityScorerPromptProfile {
  return {
    targetDisplayName: "Collaborative Systems Integration",
    targetShortName: "CSI",
    targetReferences: [
      "Collaborative Systems Integration",
      "CSI Automation",
      "csi-automation.com",
      "Collaborative Systems Integration (CSI)",
    ],
    mentionedField: "csi_mentioned",
    citedField: "csi_cited",
    positioningField: "csi_positioning",
    allowedEntityTypes: [
      "Integrator / Consultant",
      "Automation Vendor",
      "Technology Supplier",
      "Owner / Operator",
      "Standards / Industry Body",
      "Other",
    ],
    controlledSourceExample: "csi-automation.com",
  };
}

function validateRunShape(run: BenchmarkRun, definitionId: string): void {
  if (run.benchmarkDefinitionId !== definitionId) {
    throw new Error(`Existing Shadow5 run ${run.benchmarkRunKey} uses a different benchmark definition.`);
  }
  if (
    run.expectedPromptCount !== SHADOW5_PROMPT_EXTERNAL_IDS.length ||
    run.expectedPlatformCount !== SHADOW5_PLATFORMS.length ||
    run.expectedObservationCount !== EXPECTED_OBSERVATIONS
  ) {
    throw new Error(`Existing Shadow5 run ${run.benchmarkRunKey} does not have the required 5×4 shape.`);
  }
  if (run.methodologyVersion !== METHODOLOGY_VERSION) {
    throw new Error(`Existing Shadow5 run ${run.benchmarkRunKey} uses methodology ${run.methodologyVersion}.`);
  }
}

function createRun(workspaceId: string, definitionId: string, runKey: string): BenchmarkRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    workspaceId,
    benchmarkDefinitionId: definitionId,
    benchmarkRunKey: runKey,
    runDate: runKey.slice(0, 10),
    status: "queued",
    expectedPromptCount: SHADOW5_PROMPT_EXTERNAL_IDS.length,
    expectedPlatformCount: SHADOW5_PLATFORMS.length,
    expectedObservationCount: EXPECTED_OBSERVATIONS,
    successfulObservationCount: 0,
    failedObservationCount: 0,
    comparisonEligible: false,
    methodologyVersion: METHODOLOGY_VERSION,
    createdAt: now,
  };
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_SHADOW5 !== "YES") {
    throw new Error("Live Shadow5 execution is disabled. Explicitly set ALLOW_LIVE_SHADOW5=YES only after offline validation passes.");
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize persistent writes to the local development database.");
  }

  const runKey = requireEnv("SHADOW5_RUN_KEY");
  if (!/^\d{4}-\d{2}-\d{2}-shadow5-v1$/.test(runKey)) {
    throw new Error("SHADOW5_RUN_KEY must use YYYY-MM-DD-shadow5-v1.");
  }
  if (runKey === "2026-09-02-shadow-v1") {
    throw new Error("Refusing to use the existing 2026-09-02-shadow-v1 run key.");
  }

  const connectionString = requireEnv("DATABASE_URL");
  requireLocalDevDb(connectionString);

  const configuredScorerModel = process.env.SCORER_MODEL?.trim() || SCORER_MODEL;
  if (configuredScorerModel !== SCORER_MODEL) {
    throw new Error(`Shadow5 scorer must remain ${SCORER_MODEL}; received ${configuredScorerModel}.`);
  }

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const repository = new PostgresPlatformRepository(pool);
  let lockClient: PoolClient | undefined;
  let lockKey: string | undefined;
  let lockAcquired = false;

  try {
    const workspace = await repository.getWorkspaceBySlug("csi-dev");
    if (!workspace?.active) throw new Error("Active csi-dev workspace not found.");

    lockKey = `shadow5:${workspace.id}:${runKey}`;
    lockClient = await pool.connect();
    const lockResult = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [lockKey],
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      throw new Error(`Another Shadow5 process already holds the execution lock for ${runKey}.`);
    }

    const shadowDefinition = await ensureCsiShadow5Definition(pool, workspace.id);
    const definition = await repository.getBenchmarkDefinition(shadowDefinition.definitionId);
    if (!definition) throw new Error("Provisioned Shadow5 benchmark definition could not be loaded.");
    const target = await repository.getTargetEntity(definition.targetEntityId);
    if (!target) throw new Error("Shadow5 target entity could not be loaded.");

    let run = await repository.getBenchmarkRunByKey(workspace.id, runKey);
    if (!run) {
      run = createRun(workspace.id, definition.id, runKey);
      await repository.createBenchmarkRun(run);
      console.log(`Created persistent local Shadow5 run: ${runKey}`);
    } else {
      validateRunShape(run, definition.id);
      console.log(`Resuming persistent local Shadow5 run: ${runKey}`);
    }

    let plan = await buildExecutionPlan(repository, run.id);
    if (
      plan.prompts.length !== SHADOW5_PROMPT_EXTERNAL_IDS.length ||
      plan.platforms.length !== SHADOW5_PLATFORMS.length ||
      plan.run.expectedObservationCount !== EXPECTED_OBSERVATIONS
    ) {
      throw new Error("Shared execution planner did not resolve the required 5 prompts × 4 providers.");
    }
    if (plan.prompts.map((prompt) => prompt.externalPromptId).join(",") !== SHADOW5_PROMPT_EXTERNAL_IDS.join(",")) {
      throw new Error("Shared execution planner did not resolve exactly prompts 1-5.");
    }
    for (const platform of plan.platforms) {
      const expectedModel = CSI_PROVIDER_MODELS[platform.key as keyof typeof CSI_PROVIDER_MODELS];
      if (!expectedModel || platform.model !== expectedModel) {
        throw new Error(`Planner model mismatch for ${platform.key}: ${platform.model}.`);
      }
    }

    if (run.status === "complete") {
      if (plan.pendingObservations.length !== 0) {
        throw new Error(`Completed Shadow5 run ${runKey} unexpectedly has pending observations.`);
      }
      console.log(`Shadow5 run ${runKey} is already complete; zero model requests made.`);
      return;
    }

    const beforeExecution = await reconcileBenchmarkRun(repository, run.id);
    run = beforeExecution.run;
    plan = await buildExecutionPlan(repository, run.id);

    console.log(`Run key: ${runKey}`);
    console.log(`Prompts selected: ${plan.prompts.map((prompt) => prompt.externalPromptId).join(", ")}`);
    console.log(`Providers: ${plan.platforms.map((platform) => `${platform.key}:${platform.model}`).join(", ")}`);
    console.log(`Expected logical observations: ${run.expectedObservationCount}`);
    console.log(`Existing successful logical observations: ${run.successfulObservationCount}`);
    console.log(`Existing failed logical observations: ${run.failedObservationCount}`);
    console.log(`Pending logical observations: ${plan.pendingObservations.length}`);

    let httpCalls = 0;
    let invocationSuccesses = 0;
    let invocationFailures = 0;

    if (plan.pendingObservations.length > 0) {
      const maxHttpRequests = plan.pendingObservations.length * 2;
      console.log(`Maximum model requests this invocation: ${maxHttpRequests}`);

      const credentials = {
        openaiApiKey: requireEnv("OPENAI_API_KEY"),
        geminiApiKey: requireEnv("GEMINI_API_KEY"),
        perplexityApiKey: requireEnv("PERPLEXITY_API_KEY"),
        anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
      };
      const httpClient = new CappedHttpClient(maxHttpRequests);
      const registry = createCsiProviderRegistry(credentials, httpClient);
      const scorer = new OpenAIResponsesScorerClient({
        apiKey: credentials.openaiApiKey,
        model: SCORER_MODEL,
        httpClient,
      });
      const store = new PostgresObservationExecutionStore(pool);
      const scoreProfile = scorerProfile();

      for (const item of plan.pendingObservations) {
        const platform = item.platform.key as keyof typeof CSI_PROVIDER_MODELS;
        const provider = registry.get(platform);
        const service = new BenchmarkObservationExecutionService(provider, scorer, store);
        const providerPrompt = platform === "perplexity"
          ? item.prompt.text
          : benchmarkContext(item.prompt.text);

        console.log(`Executing prompt ${item.prompt.externalPromptId} on ${platform}...`);
        try {
          const result = await service.execute({
            workspaceId: workspace.id,
            benchmarkRunId: run.id,
            benchmarkRunKey: run.benchmarkRunKey,
            prompt: item.prompt,
            target,
            platform,
            providerModel: CSI_PROVIDER_MODELS[platform],
            providerPrompt,
            scorerPromptProfile: scoreProfile,
            recommendationThreshold: 4,
          });
          invocationSuccesses += 1;
          console.log(
            `  SUCCESS score=${result.scored.observation.visibilityScore}; mentioned=${result.scored.observation.targetMentioned}; ` +
            `cited=${result.scored.observation.targetCited}; recommended=${result.scored.observation.targetRecommended}; ` +
            `sources=${result.scored.observation.sources.length}; attempt=${result.scored.persistence.attempt.attemptNumber}`,
          );
        } catch (error) {
          invocationFailures += 1;
          console.error(
            `  FAILED prompt=${item.prompt.externalPromptId} platform=${platform}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      httpCalls = httpClient.calls;
      if (httpCalls > maxHttpRequests) {
        throw new Error(`Shadow5 request cap violated: ${httpCalls}/${maxHttpRequests}.`);
      }
    } else {
      console.log("No model execution needed; all logical observations are already successful.");
    }

    const reconciled = await reconcileBenchmarkRun(repository, run.id);
    console.log(`Model requests made this invocation: ${httpCalls}`);
    console.log(`Invocation successes: ${invocationSuccesses}`);
    console.log(`Invocation failures: ${invocationFailures}`);
    console.log(`Successful logical observations: ${reconciled.successfulLogicalObservations}/${EXPECTED_OBSERVATIONS}`);
    console.log(`Failed logical observations: ${reconciled.failedLogicalObservations}`);
    console.log(`Missing logical observations: ${reconciled.missingLogicalObservations}`);

    if (!reconciled.complete) {
      throw new Error("Shadow5 remains incomplete; the persistent local run is retained for diagnosis and resume/retry.");
    }

    const finalPlan = await buildExecutionPlan(repository, run.id);
    if (finalPlan.pendingObservations.length !== 0) {
      throw new Error("Complete Shadow5 run still has pending logical observations after reconciliation.");
    }

    const snapshot = buildRunMetricSnapshot({
      observations: finalPlan.existingObservations,
      prompts: finalPlan.prompts,
      platformOrder: [...SHADOW5_PLATFORMS],
      profile: methodologyProfile(),
    });
    const metricRecords = buildShadow5MetricSnapshotRecords(reconciled.run, snapshot);
    await repository.replaceMetricSnapshots(run.id, metricRecords);
    const persistedMetrics = await repository.listMetricSnapshots(run.id);
    if (persistedMetrics.length !== metricRecords.length) {
      throw new Error(`Metric snapshot persistence mismatch: expected ${metricRecords.length}, found ${persistedMetrics.length}.`);
    }

    const completedRun: BenchmarkRun = {
      ...reconciled.run,
      status: "complete",
      comparisonEligible: false,
      completedAt: new Date().toISOString(),
    };
    await repository.updateBenchmarkRun(completedRun);

    console.log(`Mention Share: ${(snapshot.mentionShare * 100).toFixed(1)}%`);
    console.log(`Citation Share: ${(snapshot.citationShare * 100).toFixed(1)}%`);
    console.log(`Recommendation Share: ${(snapshot.recommendationShare * 100).toFixed(1)}%`);
    console.log(`Provider Selection Recommendation Share: ${(snapshot.providerSelectionRecommendationShare * 100).toFixed(1)}%`);
    for (const platform of snapshot.platforms) {
      console.log(`${platform.platform} Visibility Index: ${platform.visibilityIndex}`);
    }
    console.log(`Overall Visibility Index: ${snapshot.visibilityIndex}`);
    console.log(`Metric snapshot rows persisted: ${persistedMetrics.length}`);
    console.log("Persistent Shadow5 run completed successfully and remains comparison-ineligible.");
    console.log("No n8n, Google Sheets, CSI production, or 2026-09-02-shadow-v1 changes were made.");
  } finally {
    if (lockClient) {
      if (lockAcquired && lockKey) {
        await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => undefined);
      }
      lockClient.release();
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
