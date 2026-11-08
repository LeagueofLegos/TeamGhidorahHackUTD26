# TeamGhidorahHackUTD26
This repository is for HackUTD26 Team Ghidorah.

The backend prototype uses TypeScript/Node.js, SpacetimeDB, React subscriptions, and an Arduino UNO R4 USB sensor bridge. It provides a linked asset graph, live telemetry, event history, smoothed predictions, feasible cost comparisons, a trained advisory classifier, and operator audit records. All operations are simulated advisory output; no equipment commands are sent.

Start with [the step-by-step runbook](backend/START_HERE.md). From the repository root:

```powershell
npm.cmd run setup
npm.cmd run data:fetch
npm.cmd run dev
```

In another terminal, run `npm.cmd run watch`. Use `npm.cmd run mock -- --count 35` for the live sensor demonstration without hardware.

[Frontend handoff](backend/FRONTEND.md) · [Detection and cost model details](backend/README.md) · [ML evaluation](backend/models/evaluation.json)
