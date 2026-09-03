import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PostgresObservationExecutionStore,
  PostgresPlatformRepository,
} from "@ai-visibility/database";
import { BenchmarkObservationExecutionService } from "@ai-visibility/engine";
import {
  OpenAIResponsesScorerClient,
  type HttpJsonClient,
  type HttpJsonResponse,
} from "@ai-visibility/providers";
import type { PlatformKey, PromptDefinition, TargetEntity } from "@ai-visibility/domain";
import type { VisibilityScorerPromptProfile } from "@ai-visibility/scoring";
import { createCsiProviderRegistry, CSI_PROVIDER_MODELS } from "./csi-provider-registry.js";

const platforms = ["openai", "gemini", "perplexity", "claude"] as const;
const EXPECTED_PROMPTS = 5;
const EXPECTED_OBSERVATIONS = EXPECTED_PROMPTS * platforms.length;
const MAX_HTTP_REQUESTS = EXPECTED_OBSERVATIONS * 2;

class BoundedHttpClient implements HttpJsonClient {
  calls = 0;

  async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpJsonResponse> {
    this.calls += 1;
    if (this.calls > MAX_HTTP_REQUESTS) {
      throw new Error(`Five-prompt shadow runner attempted more than ${MAX_HTTP_REQUESTS} HTTP requests.`);
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

function requireLocalDb(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || database !== "ai_visibility_dev") {
    throw new Error("Five-prompt shadow runner is restricted to local ai_visibility_dev.");
  }
}

function denverDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function normalizeIntent(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function selectFivePrompts(prompts: PromptDefinition[]): PromptDefinition[] {
  const active = prompts
    .filter((prompt) => prompt.active)
    .sort((a, b) => Number(a.externalPromptId) - Number(b.externalPromptId));
  const providerSelection = active.filter((prompt) => normalizeIntent(prompt.intent) === "provider selection");
  const other = active.filter((prompt) => normalizeIntent(prompt.intent) !== "provider selection");
  if (providerSelection.length < 2 || other.length < 3) {
    throw new Error("Five-prompt shadow requires at least 2 Provider Selection prompts and 3 non-Provider-Selection prompts.");
  }
  return [...providerSelection.slice(0, 2), ...other.slice(0, 3)]
    .sort((a, b) => Number(a.externalPromptId) - Number(b.externalPromptId));
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

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_FIVE_PROMPT_SHADOW !== "YES") {
    throw new Error(
      `Set ALLOW_LIVE_FIVE_PROMPT_SHADOW=YES to authorize up to ${MAX_HTTP_REQUESTS} external model requests.`,
    );
  }
  if (process.env.ALLOW_LOCAL_DB_VALIDATION !== "YES") {
    throw new Error("Set ALLOW_LOCAL_DB_VALIDATION=YES to authorize persistent local shadow-run writes.");
  }

  const connectionString = requireEnv("DATABASE_URL");
  requireLocalDb(connectionString);

  const credentials = {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    perplexityApiKey: requireEnv("PERPLEXITY_API_KEY"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  };
  const scorerModel = process.env.SCORER_MODEL?.trim() || "gpt-5.4-nano";
  const runDate = denverDate();
  const runKey = process.env.SHADOW5_RUN_KEY?.trim() || `${runDate}-shadow5-v1`;

  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const repository = new PostgresPlatformRepository(pool);
  const httpClient = new BoundedHttpClient();

  try {
    const workspace = await repository.getWorkspaceBySlug("csi-dev");
    if (!workspace?.active) throw new Error("Active csi-dev workspace not found.");

    const definitionResult = await pool.query(
      `SELECT id FROM benchmark_definitions WHERE workspace_id=$1 AND active=true ORDER BY id LIMIT 1`,
      [workspace.id],
    );
    const definitionId = definitionResult.rows[0]?.id as string | undefined;
    if (!definitionId) throw new Error("Active benchmark definition not found.");
    const definition = await repository.getBenchmarkDefinition(definitionId);
    if (!definition) throw new Error("Benchmark definition could not be loaded.");

    const target = await repository.getTargetEntity(definition.targetEntityId);
    if (!target) throw new Error("Benchmark target entity could not be loaded.");
    const promptSet = await repository.getPromptSetVersion(definition.promptSetVersionId);
    if (!promptSet) throw new Error("Prompt set could not be loaded.");

    const selectedPrompts = selectFivePrompts(promptSet.prompts);
    if (selectedPrompts.length !== EXPECTED_PROMPTS) throw new Error("Expected exactly five selected prompts.");

    const configuredPlatforms = new Map(definition.platforms.map((platform) => [platform.key, platform]));
    for (const platform of platforms) {
      const configured = configuredPlatforms.get(platform);
      if (!configured?.enabled) throw new Error(`Benchmark platform ${platform} is not enabled.`);
      if (configured.model !== CSI_PROVIDER_MODELS[platform]) {
        throw new Error(
          `Model mismatch for ${platform}: benchmark definition has ${configured.model}, registry expects ${CSI_PROVIDER_MODELS[platform]}.`,
        );
      }
    }

    let run = await repository.getBenchmarkRunByKey(workspace.id, runKey);
    if (!run) {
      const now = new Date().toISOString();
      run = {
        id: randomUUID(),
        workspaceId: workspace.id,
        benchmarkDefinitionId: definition.id,
        benchmarkRunKey: runKey,
        runDate,
        status: "running",
        expectedPromptCount: EXPECTED_PROMPTS,
        expectedPlatformCount: platforms.length,
        expectedObservationCount: EXPECTED_OBSERVATIONS,
        successfulObservationCount: 0,
        failedObservationCount: 0,
        comparisonEligible: false,
        methodologyVersion: "live-five-prompt-shadow-v1",
        startedAt: now,
        createdAt: now,
      };
      await repository.createBenchmarkRun(run);
      console.log(`Created persistent local shadow run: ${runKey}`);
    } else {
      if (
        run.benchmarkDefinitionId !== definition.id ||
        run.expectedPromptCount !== EXPECTED_PROMPTS ||
        run.expectedPlatformCount !== platforms.length ||
        run.expectedObservationCount !== EXPECTED_OBSERVATIONS
      ) {
        throw new Error(`Existing shadow run ${runKey} does not match the expected 5×4 structure.`);
      }
      console.log(`Resuming persistent local shadow run: ${runKey}`);
    }

    console.log(`Selected prompts: ${selectedPrompts.map((prompt) => `${prompt.externalPromptId} [${prompt.intent}]`).join(", ")}`);

    const existing = await repository.listObservations(run.id);
    const successfulKeys = new Set(
      existing
        .filter((observation) => observation.status === "SUCCESS")
        .map((observation) => `${observation.promptId}|${observation.platform}`),
    );

    const pending = selectedPrompts.flatMap((prompt) =>
      platforms.flatMap((platform) =>
        successfulKeys.has(`${prompt.id}|${platform}`) ? [] : [{ prompt, platform }],
      ),
    );

    console.log(`Existing successful observations: ${successfulKeys.size}`);
    console.log(`Pending observations: ${pending.length}`);
    console.log(`Maximum HTTP requests this invocation: ${pending.length * 2}`);

    if (pending.length === 0) {
      console.log("Nothing to execute. All 20 logical observations are already successful.");
      return;
    }

    const registry = createCsiProviderRegistry(credentials, httpClient);
    const scorer = new OpenAIResponsesScorerClient({
      apiKey: credentials.openaiApiKey,
      model: scorerModel,
      httpClient,
    });
    const store = new PostgresObservationExecutionStore(pool);
    const profile = scorerProfile();

    let invocationSuccesses = 0;
    let invocationFailures = 0;

    for (const item of pending) {
      const provider = registry.get(item.platform);
      const service = new BenchmarkObservationExecutionService(provider, scorer, store);
      const providerPrompt = item.platform === "perplexity" ? item.prompt.text : benchmarkContext(item.prompt.text);
      console.log(`Executing prompt ${item.prompt.externalPromptId} on ${item.platform}...`);
      try {
        const result = await service.execute({
          workspaceId: workspace.id,
          benchmarkRunId: run.id,
          benchmarkRunKey: run.benchmarkRunKey,
          prompt: item.prompt,
          target: target as TargetEntity,
          platform: item.platform as PlatformKey,
          providerModel: CSI_PROVIDER_MODELS[item.platform],
          providerPrompt,
          scorerPromptProfile: profile,
          recommendationThreshold: 4,
        });
        invocationSuccesses += 1;
        console.log(
          `SUCCESS prompt=${item.prompt.externalPromptId} platform=${item.platform} score=${result.scored.observation.visibilityScore} sources=${result.scored.observation.sources.length}`,
        );
      } catch (error) {
        invocationFailures += 1;
        console.error(
          `FAILED prompt=${item.prompt.externalPromptId} platform=${item.platform}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const finalObservations = await repository.listObservations(run.id);
    const successful = finalObservations.filter((observation) => observation.status === "SUCCESS").length;
    const failed = finalObservations.filter((observation) => observation.status === "FAILED").length;
    run = {
      ...run,
      status: successful === EXPECTED_OBSERVATIONS && failed === 0 ? "finalizing" : "running",
      successfulObservationCount: successful,
      failedObservationCount: failed,
      comparisonEligible: false,
    };
    await repository.updateBenchmarkRun(run);

    console.log(`HTTP requests made this invocation: ${httpClient.calls}`);
    console.log(`Invocation successes: ${invocationSuccesses}`);
    console.log(`Invocation failures: ${invocationFailures}`);
    console.log(`Canonical SUCCESS observations now: ${successful}/${EXPECTED_OBSERVATIONS}`);
    console.log(`Canonical FAILED observations now: ${failed}`);
    console.log(`Run status: ${run.status}`);
    console.log(`Persistent local shadow run retained: ${run.benchmarkRunKey}`);
    console.log("No n8n, Google Sheets, CSI production, or existing 2026-09-02-shadow-v1 records were touched.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
