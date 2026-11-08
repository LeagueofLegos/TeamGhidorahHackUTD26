# Prototype verification — 2026-11-08

Verified on Windows with Node.js 26.13.0 and SpacetimeDB 2.14.1.

The final test tooling uses Vitest 5.1.0; type checks and all nine datastore reducer tests passed after that update. `npm audit` reported zero known dependency vulnerabilities on this verification date.

`npm run test:all` passed:

- TypeScript checks for backend, bridge, generated client, tests, and database module.
- 40 domain/unit tests, including continuous-time cost feasibility, thresholds, missing data, framing, model validation, and detector persistence.
- 11 dataset integration tests, including snapshot versus full-week historical equivalence and shared-fleet allocation.
- 13 real datastore reducer tests, including writer authorization, session isolation, warmup, invalid data, acknowledgement/latching, scenario isolation, and decision revisions.
- Live server integration using a dedicated port/database and an independent subscribed client: graph, six current episodes, S2 cost **$3,120.94**, what-if isolation, audit record, denied reader writes, real-time mock prediction, duplicate rejection, invalid-level handling, six-well trip, and scheduled stale-data handling.

Also exercised the repository-root data download/startup commands, mock bridge, configurable compressor comparison, and native serial-port enumeration. Temporary test servers were stopped after verification. The data download is pinned to challenge commit `135ba4c8348357457420a1111df80ec1906bcbdb`.

The improved model uses 6,102 training rows, 3,016 validation rows and 11,027 final test rows. The selected eight-feature model improves same-test macro F1 from **0.973744** to **0.993862**. With abstention, coverage is **0.999093** and accepted-label accuracy **0.999183**. Three newly starting held-out inspection events were detected after 20–25 field minutes with zero unmatched confirmed episodes in this evaluation. Carry-in events are excluded from onset-delay metrics. This remains synthetic-data validation, not field validation; scores are not physical failure probabilities.

The Arduino sketch was provided for calibration and manual upload. No board was flashed, no serial port was opened, and no physical equipment was actuated during verification. Physical sensor calibration, wiring, and a water-container bench test remain the hardware teammate's responsibility. The existing React frontend has been integrated, built and exercised in a browser against a dedicated database. Browser checks covered local authorization, snapshot costs, all-at-risk full-field stop, rejected premature restart, and economic full-field stop. Four frontend adapter tests cover warning units, stale/disconnected inputs, field latches and zero ETAs.

Live integration also verifies all 45 wells go to zero effective production after economic or all-at-risk triggers, recorded well status remains unchanged, warning countdowns remain separately available, and reviewed restart succeeds only after clearing the trigger. The repository architecture map is `../ARCHITECTURE.md`.
