# AI Visibility Platform

A multi-workspace platform for measuring how AI systems discover, cite, position, and recommend organizations and brands.

## Architecture

- `apps/web` — web application and dashboards
- `packages/domain` — shared platform domain model
- `packages/engine` — benchmark orchestration, resume/retry, completeness and finalization
- `packages/providers` — AI provider adapters
- `packages/scoring` — versioned scoring profiles
- `packages/authority` — independent-authority classification
- `packages/database` — persistence contracts and Postgres implementation
- `packages/integrations/csi-legacy` — read-only CSI compatibility/parity integration
- `docs` — architecture, methodology and migration documentation

## Development status

**FOUNDATION / NON-PRODUCTION**

This repository is intentionally separate from the existing CSI AI Visibility production system. It does not trigger or modify the CSI n8n workflows, Google Sheets, Apps Script API, Netlify dashboard, or scheduled benchmark.

CSI will be the first reference workspace and parity dataset, not a hard-coded platform dependency.

## Product model

Measure → diagnose → recommend → track improvement.
