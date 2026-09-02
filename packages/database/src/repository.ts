import type {
  AuthorityResult,
  BenchmarkDefinition,
  BenchmarkRun,
  Observation,
  PromptSetVersion,
  TargetEntity,
  Workspace,
} from "@ai-visibility/domain";

export interface MetricSnapshotRecord {
  id: string;
  workspaceId: string;
  benchmarkRunId: string;
  metricKey: string;
  scopeType: string;
  scopeKey: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  methodologyVersion: string;
  createdAt: string;
}

export interface PlatformRepository {
  getWorkspaceById(id: string): Promise<Workspace | null>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | null>;
  createWorkspace(workspace: Workspace): Promise<void>;

  getTargetEntity(id: string): Promise<TargetEntity | null>;
  getPromptSetVersion(id: string): Promise<PromptSetVersion | null>;
  getBenchmarkDefinition(id: string): Promise<BenchmarkDefinition | null>;

  getBenchmarkRunById(id: string): Promise<BenchmarkRun | null>;
  getBenchmarkRunByKey(workspaceId: string, benchmarkRunKey: string): Promise<BenchmarkRun | null>;
  createBenchmarkRun(run: BenchmarkRun): Promise<void>;
  updateBenchmarkRun(run: BenchmarkRun): Promise<void>;
  listCompleteRuns(workspaceId: string, limit?: number): Promise<BenchmarkRun[]>;

  listObservations(benchmarkRunId: string): Promise<Observation[]>;
  getObservation(benchmarkRunId: string, promptId: string, platform: string): Promise<Observation | null>;
  upsertObservation(observation: Observation): Promise<void>;

  listAuthorityResults(benchmarkRunId: string, classifierVersion?: string): Promise<AuthorityResult[]>;
  upsertAuthorityResult(result: AuthorityResult): Promise<void>;

  replaceMetricSnapshots(benchmarkRunId: string, snapshots: MetricSnapshotRecord[]): Promise<void>;
  listMetricSnapshots(benchmarkRunId: string): Promise<MetricSnapshotRecord[]>;
}
