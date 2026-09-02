BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE target_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, canonical_name)
);

CREATE TABLE target_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_entity_id uuid NOT NULL REFERENCES target_entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  UNIQUE (target_entity_id, alias)
);

CREATE TABLE owned_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_entity_id uuid NOT NULL REFERENCES target_entities(id) ON DELETE CASCADE,
  domain text NOT NULL,
  UNIQUE (target_entity_id, domain)
);

CREATE TABLE competitor_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, canonical_name)
);

CREATE TABLE competitor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_entity_id uuid NOT NULL REFERENCES competitor_entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  UNIQUE (competitor_entity_id, alias)
);

CREATE TABLE competitor_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_entity_id uuid NOT NULL REFERENCES competitor_entities(id) ON DELETE CASCADE,
  domain text NOT NULL,
  UNIQUE (competitor_entity_id, domain)
);

CREATE TABLE prompt_set_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_set_version_id uuid NOT NULL REFERENCES prompt_set_versions(id) ON DELETE CASCADE,
  external_prompt_id text NOT NULL,
  prompt_text text NOT NULL,
  category text NOT NULL,
  intent text NOT NULL,
  weight numeric(10,4) NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_set_version_id, external_prompt_id)
);

CREATE TABLE scoring_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_key text NOT NULL,
  version text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, profile_key, version)
);

CREATE TABLE authority_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_key text NOT NULL,
  version text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, profile_key, version)
);

CREATE TABLE benchmark_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES target_entities(id) ON DELETE RESTRICT,
  prompt_set_version_id uuid NOT NULL REFERENCES prompt_set_versions(id) ON DELETE RESTRICT,
  scoring_profile_version text NOT NULL,
  authority_profile_version text,
  expected_prompt_count integer NOT NULL CHECK (expected_prompt_count >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE benchmark_platforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_definition_id uuid NOT NULL REFERENCES benchmark_definitions(id) ON DELETE CASCADE,
  platform_key text NOT NULL,
  display_name text NOT NULL,
  model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (benchmark_definition_id, platform_key)
);

CREATE TABLE benchmark_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  benchmark_definition_id uuid NOT NULL REFERENCES benchmark_definitions(id) ON DELETE RESTRICT,
  benchmark_run_key text NOT NULL,
  run_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','finalizing','complete','incomplete','failed')),
  expected_prompt_count integer NOT NULL CHECK (expected_prompt_count >= 0),
  expected_platform_count integer NOT NULL CHECK (expected_platform_count >= 0),
  expected_observation_count integer NOT NULL CHECK (expected_observation_count >= 0),
  successful_observation_count integer NOT NULL DEFAULT 0 CHECK (successful_observation_count >= 0),
  failed_observation_count integer NOT NULL DEFAULT 0 CHECK (failed_observation_count >= 0),
  comparison_eligible boolean NOT NULL DEFAULT false,
  methodology_version text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, benchmark_run_key)
);

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  benchmark_run_key text NOT NULL,
  prompt_id uuid NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
  platform_key text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
  answer_text text,
  error_code text,
  error_message text,
  target_mentioned boolean,
  target_cited boolean,
  target_recommended boolean,
  target_positioning text,
  visibility_score numeric(12,6),
  weighted_score numeric(12,6),
  scorer_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (benchmark_run_id, prompt_id, platform_key)
);

CREATE INDEX idx_observations_run ON observations (benchmark_run_id);
CREATE INDEX idx_observations_workspace_run_key ON observations (workspace_id, benchmark_run_key);
CREATE INDEX idx_observations_prompt_platform ON observations (prompt_id, platform_key);
CREATE INDEX idx_observations_status ON observations (status);

CREATE TABLE observation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
  provider_request_id text,
  raw_response_ref text,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (observation_id, attempt_number)
);

CREATE TABLE observation_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  url text NOT NULL,
  domain text NOT NULL,
  owned_by_target boolean NOT NULL DEFAULT false,
  source_order integer NOT NULL DEFAULT 0,
  UNIQUE (observation_id, url)
);

CREATE INDEX idx_observation_sources_domain ON observation_sources (domain);

CREATE TABLE observation_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('target','competitor','other')),
  canonical_name text NOT NULL,
  competitor_entity_id uuid REFERENCES competitor_entities(id) ON DELETE SET NULL,
  UNIQUE (observation_id, entity_type, canonical_name)
);

CREATE TABLE authority_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  classifier_version text NOT NULL,
  support_type text NOT NULL CHECK (support_type IN ('NONE','OWN_ONLY','INDEPENDENT_ONLY','MIXED')),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 3),
  qualifies boolean NOT NULL,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (observation_id, classifier_version)
);

CREATE TABLE authority_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority_result_id uuid NOT NULL REFERENCES authority_results(id) ON DELETE CASCADE,
  domain text NOT NULL,
  url text,
  source_tier text,
  claim text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  scope_type text NOT NULL DEFAULT 'overall',
  scope_key text NOT NULL DEFAULT 'overall',
  value numeric(18,8),
  numerator numeric(18,8),
  denominator numeric(18,8),
  methodology_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (benchmark_run_id, metric_key, scope_type, scope_key, methodology_version)
);

CREATE INDEX idx_metric_snapshots_run ON metric_snapshots (benchmark_run_id);

CREATE TABLE diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  diagnostic_key text NOT NULL,
  severity text,
  title text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  methodology_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE diagnostic_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagnostic_id uuid NOT NULL REFERENCES diagnostics(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES observations(id) ON DELETE SET NULL,
  metric_snapshot_id uuid REFERENCES metric_snapshots(id) ON DELETE SET NULL,
  evidence_type text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recommended_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  diagnostic_id uuid REFERENCES diagnostics(id) ON DELETE SET NULL,
  title text NOT NULL,
  rationale text NOT NULL,
  priority integer,
  status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
