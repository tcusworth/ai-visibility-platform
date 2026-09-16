# CSI Visibility Operator

Static, read-only dashboard for finalized CSI AI Visibility benchmark runs.

## Local preview

```bash
python3 -m http.server 4173 --directory apps/web
```

Open `http://localhost:4173`.

The dashboard uses `data.js` as its published snapshot. It does not execute providers, write to the benchmark database, or call the CSI production workflow.
