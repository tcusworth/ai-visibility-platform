# CSI Legacy Integration

Read-only compatibility layer for validating the new platform against the existing CSI AI Visibility benchmark.

CSI is a reference workspace, not part of the generic engine.

This integration may read legacy CSI Results/Summary data for parity testing. It must not write to the CSI production Google Sheet, trigger n8n workflows, or alter the production dashboard.

Canonical baseline reference: `2026-08-27-full100-v1`, 400 logical observations after last-row-wins deduplication.
