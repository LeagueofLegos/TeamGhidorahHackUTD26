import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.js";
import { analyzeDataset } from "../src/detection.js";
import { planDataset } from "../src/planning_dataset.js";
import { evaluateField, DEFAULT_FIELD_POLICY } from "../src/field_control.js";
import {
  createTankContext,
  advanceTankContext,
  warningForecasts,
} from "../src/warning_forecast.js";
import {
  createMLContext,
  advanceMLContext,
  contextFeatures,
  infer,
  type Model,
} from "../src/ml.js";
import { readFileSync } from "node:fs";
function current(level = 87, status = 2) {
  const d = fixture();
  d.readings = [];
  for (let i = 0; i < 3; i++) {
    const ts = i * 300;
    for (const [asset_id, metric, value] of [
      ["T", "level_pct", level - 2 + i],
      ["F", "inflow_bpd", 2400],
      ["P", "status", status],
      ["P", "flow_bpd", status === 2 ? 0 : 3000],
      ["L", "receive_flow_bpd", status === 2 ? 0 : 3000],
      ["W", "status", 1],
      ["W", "water_bpd", 2400],
    ] as const)
      d.readings.push({
        asset_id,
        metric,
        value,
        ts_unix: ts,
        timestamp: new Date(ts * 1000).toISOString(),
      });
  }
  d.nowTs = 600;
  return d;
}
test("full field trips when every producing facility has a usable fault forecast", () => {
  const d = current(),
    a = analyzeDataset(d),
    r = planDataset(d, a, { horizonHours: 6 }),
    decision = evaluateField(d, a, r, DEFAULT_FIELD_POLICY);
  assert.equal(decision.triggerReason, "all_producing_facilities_at_risk");
  assert.equal(decision.producingWells, 1);
  assert.equal(decision.fullShutdown.lostRevenue, 360);
});
test("economic trigger counts healthy-well revenue and explicit avoidable field costs", () => {
  const d = current(50, 1),
    a = analyzeDataset(d),
    r = planDataset(d, a),
    normal = evaluateField(d, a, r, DEFAULT_FIELD_POLICY);
  assert.equal(normal.trigger, false);
  const expensive = evaluateField(d, a, r, {
    ...DEFAULT_FIELD_POLICY,
    avoidableOperatingCostPerHour: 100,
  });
  assert.equal(expensive.triggerReason, "lowest_modeled_cost");
  assert.equal(expensive.selective.totalCost, 600);
  assert.equal(expensive.fullShutdown.totalCost, 360);
});
test("stale, missing status, truncated search, no production and ties cannot create an economic shutdown", () => {
  const d = current(50, 1),
    a = analyzeDataset(d),
    r = planDataset(d, a),
    policy = { ...DEFAULT_FIELD_POLICY, avoidableOperatingCostPerHour: 100 };
  assert.equal(evaluateField(d, a, r, policy, "stale").trigger, false);
  const truncated = structuredClone(r);
  for (const s of truncated.systems)
    if (s.status !== "unavailable") s.result.search.truncated = true;
  assert.equal(evaluateField(d, a, truncated, policy).trigger, false);
  d.readings = d.readings.filter(
    (row) => row.metric !== "status" || row.asset_id !== "W",
  );
  assert.equal(evaluateField(d, a, r, policy).trigger, false);
});
test("warning countdown applies without a fault and handles warmup, draining, threshold and staleness", () => {
  const d = current(),
    context = createTankContext();
  for (let i = 0; i < d.readings.length; i += 7)
    advanceTankContext(context, d.network, d.readings.slice(i, i + 7));
  let p = warningForecasts(
    context,
    d.network,
    d.readings.filter((r) => r.ts_unix === 600),
    600,
  )[0];
  assert.equal(p.state, "rising");
  assert.equal(p.hoursToShutdown, 0.5);
  assert.equal(
    warningForecasts(
      context,
      d.network,
      d.readings.filter((r) => r.ts_unix === 600),
      600,
      "stale",
    )[0].hoursToShutdown,
    null,
  );
  const draining = current(87, 1),
    c = createTankContext();
  for (let i = 0; i < draining.readings.length; i += 7)
    advanceTankContext(c, draining.network, draining.readings.slice(i, i + 7));
  assert.equal(
    warningForecasts(
      c,
      draining.network,
      draining.readings.filter((r) => r.ts_unix === 600),
      600,
    )[0].state,
    "not_filling",
  );
});
test("ML context is causal, resets on stopped pumps and rejects unsupported/ambiguous features", () => {
  const d = current(50, 1),
    context = createMLContext();
  const rows = d.readings.filter((r) => r.ts_unix === 0);
  rows.push(
    {
      asset_id: "P",
      metric: "discharge_psi",
      value: 1150,
      ts_unix: 0,
      timestamp: new Date(0).toISOString(),
    },
    {
      asset_id: "L",
      metric: "pressure_psi",
      value: 1050,
      ts_unix: 0,
      timestamp: new Date(0).toISOString(),
    },
  );
  advanceMLContext(context, d.network, rows);
  assert.deepEqual(contextFeatures(context, "F"), [1, 0, 1, 1, 1, 0, 1, 1]);
  advanceMLContext(
    context,
    d.network,
    d.readings
      .filter((r) => r.ts_unix === 300)
      .map((r) =>
        r.asset_id === "P" && r.metric === "status" ? { ...r, value: 0 } : r,
      ),
  );
  assert.equal(contextFeatures(context, "F"), null);
  const m = JSON.parse(readFileSync("models/anomaly.json", "utf8")) as Model,
    x = [1, 0, 1, 1, 1, 0, 1, 1].slice(0, m.features.length);
  assert.equal(
    infer(
      m,
      x.map(() => 1e99),
      m.trainedThroughTs + 300,
    ).state,
    "out_of_distribution",
  );
  const flat = {
    ...m,
    weights: m.weights.map((w) => w.map(() => 0)),
    bias: [0, 0, 0],
  };
  assert.equal(infer(flat, x, m.trainedThroughTs + 300).state, "uncertain");
  assert.equal(infer(flat, x, m.trainedThroughTs + 300).label, null);
});
