# Prototype verification — 2026-11-08

Verified on Windows with Node.js 26.13.0 and SpacetimeDB 2.14.1.

The final test tooling uses Vitest 5.1.0; type checks and all nine datastore reducer tests passed after that update. `npm audit` reported zero known dependency vulnerabilities on this verification date.

`npm run test:all` passed:

- TypeScript checks for backend, bridge, generated client, tests, and database module.
- 35 domain/unit tests, including continuous-time cost feasibility, thresholds, missing data, framing, model validation, and detector persistence.
- 11 dataset integration tests, including snapshot versus full-week historical equivalence and shared-fleet allocation.
- Nine real datastore reducer tests, including writer authorization, session isolation, warmup, invalid data, acknowledgement/latching, scenario isolation, and decision revisions.
- Live server integration using a dedicated port/database and an independent subscribed client: graph, six current episodes, S2 cost **$3,120.94**, what-if isolation, audit record, denied reader writes, real-time mock prediction, duplicate rejection, invalid-level handling, six-well trip, and scheduled stale-data handling.

Also exercised the repository-root data download/startup commands, mock bridge, configurable compressor comparison, and native serial-port enumeration. Temporary test servers were stopped after verification. The data download is pinned to challenge commit `135ba4c8348357457420a1111df80ec1906bcbdb`.

The actual trained classifier reports macro F1 **0.977644** on 14,043 held-out synthetic running-pump samples after training on the first 6,102 samples in time. The complete confusion matrix and per-class results are in `models/evaluation.json`. This is a temporal split within one synthetic network, not independent field validation. Model scores are uncalibrated.

The Arduino sketch was provided for calibration and manual upload. No board was flashed, no serial port was opened, and no physical equipment was actuated during verification. Physical sensor calibration, wiring, and a water-container bench test remain the hardware teammate's responsibility. The React subscription helper and handoff are included; a finished React dashboard is outside this backend implementation.
