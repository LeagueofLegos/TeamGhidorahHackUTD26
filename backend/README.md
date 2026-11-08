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

The detection report also includes the selected cost-plan kind and modeled cost for ongoing pump failures. An unavailable plan is labeled `awaiting_planning_data`. Inspection costs are unspecified by the input data and displayed as null, rather than being invented as free work.

## Compare response costs

```powershell
npm run plan -- data/HackUTD-ZeroDay/history/snapshot_2026-10-08T1200
npm run plan -- data/HackUTD-ZeroDay/history/snapshot_2026-10-09T0330
npm run plan -- data/HackUTD-ZeroDay/history/snapshot_2026-10-10T0900
```

The optional second positional argument is a UTC replay timestamp, just as with `detect`. Use `--json` for a machine-readable report containing plans, alternatives, costs, timelines, and truck reservations:

```powershell
npm run --silent plan -- data/HackUTD-ZeroDay/history/full_week 2026-10-08T12:00:00Z --json
```

The planner evaluates accepting protective shutdown, delayed individual well shut-ins, full-load truck jobs, and combinations. Each system is planned jointly, so a truck cannot be assigned to overlapping jobs. It can help another facility after its final round trip returns to the yard; the new facility's response time then applies again. All trucks in a facility job are called together. Different trucks may stop after different numbers of trips.

Cost is incremental trucking expense plus lost oil/gas revenue over the expected repair time remaining. Prices, rates, capacities, fleet size, and travel times come from the files. Gas is already in mcf/day: there is no extra factor of 1,000. Initially inactive wells contribute unavoidable loss. An already-shut-in facility stays shut until repair; hauling water does not imply a restart.

### Model and search scope

Future well water rates are held at their configured baselines. The failed pump is assumed stopped. The measured current tank volume sets the starting state. This differs deliberately from the detection ETA, which smooths measured net flow. Sensor noise therefore causes small differences from the practice reference costs.

For each generated truck schedule, the planner optimizes continuous well shut-in times. The no-truck case is solved by the least revenue lost per barrel of water avoided. Truck cases enumerate the intervals between arrivals and solve the resulting small linear programs by vertex enumeration. Every returned preventive plan is checked by a separate continuous-time simulator, including the tank level immediately before unloading. A full load must actually be present, and every trip must arrive strictly before repair completion. Reaching the shutdown limit at the same instant as an arrival does not count as prevention.

Truck calls start at the earliest candidate time allowed by vehicle availability and the water required for full loads. Arbitrary discretionary dispatch delays are not exhaustively searched. The system search considers facility order, vehicle subsets, trip counts, and vehicle reuse. The result is **best found within this enumerated model**, not a guarantee of an unrestricted global optimum.

`PlanningOptions` bounds search states, linear vertices, trip counts, and controllable wells. Defaults allow 10,000 search states, 1,000,000 vertices, six trips per truck, and four controllable wells in a truck-assisted linear program. No-truck planning supports larger well lists. If a limit is reached, `search.truncated` is true and the result retains a feasible baseline or best-found plan. The CLI prints this condition explicitly. A 0.01-barrel modeling margin keeps preventive trajectories strictly below shutdown; it is not a real equipment protection setting.

Data must be fresh and complete at the chosen recorded timestamp. A first fault frame can receive a baseline-rate cost comparison even while the smoothed trend prediction is warming up; the report identifies the cost model's baseline-rate basis. Missing fault/tank/well data, an overdue expected repair, or material pumping despite fault status makes that system's shared-fleet recommendation unavailable. The planner never invents an immediate repair or changes the recording to reflect its advice.

`comparisons.standaloneAlternatives` contains generated feasible single-facility alternatives assuming the fleet is initially available. Those rows cannot be independently combined across facilities. `plans` contains the selected allocation that respects the shared fleet.

At the supplied October 8 12:00 snapshot, S2's plan uses one truck each at facilities A and B and a delayed shut-in of S2_WELL_C1. The model totals about $3,120.94, including $1,810 in trucking and $1,310.94 in lost revenue, compared with about $12,214.94 for accepting all three shutdowns. Runtime code does not load reference actions.

SpacetimeDB publishing, frontend subscriptions, and the read-only Arduino bridge remain the next integration stage. The stack remains TypeScript/Node.js, SpacetimeDB, React, and Arduino over USB. Detection currently uses rules/statistics and cost planning uses mathematical search. No trained machine-learning model is claimed by this implementation.

## Tests

```powershell
npm test
npm run test:integration
```

Unit tests are self-contained. They cover detection, independent cost arithmetic, shutdown/arrival boundaries, full loads, unequal trip counts, shared-truck conflicts and reuse, initial shut-in state, mixed plans, and bounded-search fallback. A separate time-grid oracle checks the continuous well-control optimizer on a small fixture.

Integration tests require the ignored practice data and check the practice-week counts plus equivalence between snapshots and replay of the full week up to the same time. This checks for accidental use of future measurements in both detection and planning. They also check the expected shared-fleet response patterns at the three snapshots. Integration tests use only the three application input files, with fixed practice expectations written in the tests.

To use data stored elsewhere, set the environment variable in the current PowerShell terminal:

```powershell
$env:GHIDORAH_HISTORY_DIR = 'C:\path\to\HackUTD-ZeroDay\history'
npm run test:integration
```

On the supplied practice week, the detector finds 13 failure episodes, five leaks, and five degradation episodes, all resolved by the end. This is practice-set validation, not a guarantee of accuracy on the unseen judging dataset. No Arduino or physical sensors have been actuated or bench-tested by these tests.
