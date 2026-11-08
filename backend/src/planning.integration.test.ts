import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { loadDataset } from "./dataset.js";
import { analyzeDataset } from "./detection.js";
import { planDataset } from "./planning_dataset.js";
import { validateFleet } from "./planning.js";

const history = process.env.GHIDORAH_HISTORY_DIR ?? "data/HackUTD-ZeroDay/history";
let fullWeek: ReturnType<typeof loadDataset> | undefined;
const full = () => fullWeek ??= loadDataset(join(history, "full_week"));

for (const [folder, systemId, expected] of [
  ["snapshot_2026-10-08T1200", "S2", { S2_FACILITY_A: "trucking", S2_FACILITY_B: "trucking", S2_FACILITY_C: "well_shut_in" }],
  ["snapshot_2026-10-09T0330", "S4", { S4_FACILITY_C: "trucking" }],
  ["snapshot_2026-10-10T0900", "S4", { S4_FACILITY_A: "mixed", S4_FACILITY_C: "trucking", S4_FACILITY_D: "well_shut_in" }]
] as const) {
  test(`${folder}: shared-fleet plan is feasible and independent of future data`, async () => {
    const dataset = await loadDataset(join(history, folder));
    const analysis = analyzeDataset(dataset);
    const beforeCount = dataset.readings.length;
    const report = planDataset(dataset, analysis);
    const system = report.systems.find(item => item.systemId === systemId)!;
    assert.notEqual(system.status, "unavailable");
    if (system.status === "unavailable") throw new Error(system.reasons.join(" "));
    const result = system.result;
    assert.equal(result.search.truncated, false);
    assert.equal(validateFleet(result.plans, result.truckIds), true);
    assert.ok(result.totalCost < result.baselineCost);
    assert.deepEqual(Object.fromEntries(result.plans.map(plan => [plan.facilityId, plan.kind])), expected);
    if (folder === "snapshot_2026-10-08T1200") assert.ok(result.totalCost > 3100 && result.totalCost < 3150);
    if (folder === "snapshot_2026-10-09T0330") assert.equal(result.totalCost, 1810);
    if (folder === "snapshot_2026-10-10T0900") assert.ok(result.totalCost > 3000 && result.totalCost < 3100);
    const recording = await full();
    assert.deepEqual(planDataset(recording, analyzeDataset(recording, dataset.nowTs)), report);
    assert.equal(dataset.readings.length, beforeCount, "Plans must not mutate recorded telemetry.");
  });
}

test("a historical failure can be planned at onset using baseline rates without future observations", async () => {
  const dataset = await full();
  const at = Date.parse("2026-10-08T00:20:00Z") / 1000;
  const analysis = analyzeDataset(dataset, at);
  const system = planDataset(dataset, analysis).systems.find(item => item.systemId === "S1")!;
  if (system.status === "unavailable") throw new Error(system.reasons.join(" "));
  const plan = system.result.plans.find(item => item.facilityId === "S1_FACILITY_C")!;
  assert.equal(plan.kind, "trucking");
  assert.equal(plan.totalCost, 905);
});

test("the finished practice week has no active failure response costs", async () => {
  const report = planDataset(await full());
  for (const system of report.systems) {
    assert.equal(system.status, "no_failures");
    assert.equal(system.result.totalCost, 0);
  }
});

test("missing current level makes the whole shared-system allocation unavailable", async () => {
  const dataset = await loadDataset(join(history, "snapshot_2026-10-08T1200"));
  const modified = { ...dataset, readings: dataset.readings.filter(row =>
    !(row.ts_unix === dataset.nowTs && row.asset_id === "S2_TANK_A" && row.metric === "level_pct")) };
  const result = planDataset(modified).systems.find(item => item.systemId === "S2")!;
  assert.equal(result.status, "unavailable");
});

test("planning between frames does not pretend that old values are current", async () => {
  const dataset = await loadDataset(join(history, "snapshot_2026-10-08T1200"));
  const analysis = analyzeDataset(dataset, dataset.nowTs - 60);
  assert.equal(planDataset(dataset, analysis).systems.find(item => item.systemId === "S2")!.status, "unavailable");
});
