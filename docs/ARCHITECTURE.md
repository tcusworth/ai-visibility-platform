# Platform Architecture

Status: FOUNDATION / NON-PRODUCTION

## Objective

Build a reusable multi-workspace AI Visibility Benchmark Platform in which a company, brand, practice, or organization is configuration rather than application code.

## Core flow

```text
Workspace
  ↓
Target + competitors
  ↓
Versioned prompt set + benchmark definition
  ↓
Benchmark engine
  ↓
Provider adapters
  ↓
Normalization + versioned scoring
  ↓
Independent authority analysis
  ↓
Completeness gate
  ↓
Metrics + diagnostics
  ↓
PostgreSQL history
  ↓
Dashboard / reports / API
```

## Canonical observation rule

One logical observation is one AI platform response to one prompt within one benchmark run.

Logical identity:

```text
benchmark_run_key + prompt_id + platform
```

Retries must not create multiple logical observations. Successful observations are skipped on resume. Failed observations remain explicit data-quality records and are eligible for retry. Visibility denominators include successful logical observations only.

## Isolation from CSI production

The existing CSI implementation remains independent:

```text
CSI production
n8n → Google Sheets → Apps Script → Netlify dashboard
```

The new platform is:

```text
AI Visibility Platform
TypeScript engine → PostgreSQL → platform API/web app
```

No new-platform scheduler, provider adapter, database migration, or web deployment is connected to CSI production during the foundation phase.

CSI-specific compatibility logic belongs only under `packages/integrations/csi-legacy`.

## Methodology governance

Scoring, recommendation classification, provider-selection classification, authority classification, and composite-index formulas are versioned. Reporting consumes those governed outputs rather than silently redefining them.

The processing hierarchy is:

```text
Observation → Metric → Diagnostic → Recommended Action
```

## Initial implementation order

1. Generic domain model and benchmark engine contracts.
2. In-memory repository and automated engine tests.
3. Generic authority/finalization pipeline.
4. PostgreSQL schema and repository.
5. CSI read-only legacy adapter and baseline parity import.
6. Provider adapters in shadow mode.
7. Web application.
8. Multi-workspace scheduling and operations.
9. Production cutover only after explicit parity and operational acceptance.
