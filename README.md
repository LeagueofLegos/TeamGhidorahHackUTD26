# TeamGhidorahHackUTD26
This repository is for HackUTD26 Team Ghidorah.

The integrated prototype uses TypeScript/Node.js, SpacetimeDB, React subscriptions, and an Arduino UNO R4 USB sensor bridge. It provides a linked asset graph, live telemetry, event history, smoothed predictions, feasible cost comparisons, a trained advisory classifier, and operator audit records. All operations are simulated advisory output; no equipment commands are sent.

Start with [the step-by-step runbook](backend/START_HERE.md). From the repository root:

```powershell
npm.cmd run setup
npm.cmd run data:fetch
npm.cmd run dev
```

Open **http://127.0.0.1:5173** for the connected dashboard. In another terminal, run `npm.cmd run watch` for the console view. Use `npm.cmd run mock -- --count 35` for the live sensor demonstration without hardware.

[Frontend handoff](backend/FRONTEND.md) · [Detection and cost model details](backend/README.md) · [ML evaluation](backend/models/evaluation.json)

[Complete stack and file map](ARCHITECTURE.md) · Frontend source: `frontend/` · ML: `backend/src/ml.ts`, `backend/src/ml_training.ts`, `backend/models/` · Automatic software-only full-field shutdown: `backend/src/field_control.ts` · Warning countdowns: `backend/src/warning_forecast.ts`.
