# Ghidorah backend

TypeScript backend foundation for the HackUTD water-disposal challenge. Input data, tank limits, production, and prices come from the selected challenge folder. All results are simulated advisory output. There is no equipment-control interface.

## Install and check

Use Node.js 26.13.0 (the version used for verification) and npm. From this folder:

```powershell
npm ci
npm run check
npm test
```

On Windows, use `npm.cmd` if PowerShell blocks the npm script launcher. The lockfile records the dependency versions used by this project.

## Obtain the data

From this folder:

```powershell
git clone --depth 1 https://github.com/nihaal419/HackUTD-ZeroDay.git data/HackUTD-ZeroDay
```

`data/` is ignored by Git. Runtime code opens only `network.json`, `ops.json`, and `telemetry.csv`. Answer keys are not loaded by the application or by the integration tests. The fixed practice counts in integration tests are test expectations, not detection inputs.

## Inspect current equipment state

```powershell
npm run inspect
npm run inspect -- data/HackUTD-ZeroDay/history/full_week S1_TANK_A
```

The report shows current tank volume, space below shutdown, nominal hourly revenue, and an initial instantaneous countdown when a pump reports fault. Revenue is the facility's nominal oil/gas value; it is not actual sales while wells are shut in.

## Detect problems and predict shutdown

```powershell
npm run detect
npm run detect -- data/HackUTD-ZeroDay/history/snapshot_2026-10-08T1200
```

The first argument selects any dataset folder with the three input files. To replay an earlier time, add a UTC timestamp:

```powershell
npm run detect -- data/HackUTD-ZeroDay/history/full_week 2026-10-08T12:00:00Z
```

The dataset's last telemetry timestamp supplies the default replay time. The wall clock is never used to expire a historical recording. The detector processes complete timestamp groups in order and does not inspect later readings during earlier-time analysis.

The detector produces:

- Separate ongoing/resolved pump-failure, pump-degradation, and pipeline-leak episodes.
- The first suspicious observation and the later confirmation time, where confirmation is required.
- A sorted list of ongoing alerts, with pump failures ordered by estimated time to shutdown and then nominal revenue at risk.
- Smoothed pump-failure countdowns and expected repair time remaining.
- `field_inspection` responses for leaks and degradation.

Pump failures use explicit fault status 2. A normal stopped pump (status 0) is not classified as a failure. Inspection alerts use a five-running-sample median and three consecutive suspicious running observations. A flow ratio below 98% flags pump degradation; a received-flow shortfall above 2.5% flags a possible leak. Recovery uses separate thresholds to reduce toggling. These are configurable detection heuristics in `DETECTION_SETTINGS`, not real equipment protection limits or calibrated failure probabilities.

Prediction uses the latest raw level and the median net inflow over up to 30 minutes. At least three flow samples are required. An observed raw shutdown crossing produces zero remaining time immediately. Missing, stale, or nonpositive-flow data never produce a fabricated countdown. At five-minute sampling, three samples normally span ten minutes. Gaps over ten minutes clear the prediction window. A latched equipment-control action is not created by this analysis.

Expected repairs use the duration in `ops.json`, measured from the first observed fault. A zero expected remaining duration does not falsely resolve an event if telemetry still reports a fault. Slow faults can be detected after their true onset; `onsetTs` means the first suspicious observation supporting this detector, not hidden knowledge of the generator's start time. Resolution also waits for observable recovery.

Cost planning is the next implementation stage. The detection CLI explicitly marks pump-failure responses as `cost planning pending`; it does not pretend to have selected a truck or well shut-in plan. SpacetimeDB publishing, frontend subscriptions, and the read-only Arduino bridge will build on these pure analysis functions.

## Tests

```powershell
npm test
npm run test:integration
```

Unit tests are self-contained. Integration tests require the ignored practice data and check the practice-week counts plus equivalence between snapshots and replay of the full week up to the same time. That equivalence tests for accidental use of future measurements.

To use data stored elsewhere, set the environment variable in the current PowerShell terminal:

```powershell
$env:GHIDORAH_HISTORY_DIR = 'C:\path\to\HackUTD-ZeroDay\history'
npm run test:integration
```

On the supplied practice week, the detector finds 13 failure episodes, five leaks, and five degradation episodes, all resolved by the end. This is practice-set validation, not a guarantee of accuracy on the unseen judging dataset. No Arduino or physical sensors have been actuated or bench-tested by these tests.
