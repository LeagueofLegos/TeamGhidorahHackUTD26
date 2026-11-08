import assert from "node:assert/strict";
import test from "node:test";
import type { Dataset, Reading } from "./dataset.js";
import { analyzeDataset } from "./detection.js";

type Step = { ts: number; status?: number | null; level?: number; flow?: number | null; received?: number };
function fixture(steps: Step[]): Dataset {
  const readings: Reading[] = [];
  for (const step of steps) {
    const values: [string, string, number][] = [
      ["T", "level_pct", step.level ?? 50],
      ["F", "inflow_bpd", 2400],
      ["L", "receive_flow_bpd", step.received ?? 3000]
    ];
    if (step.status !== null) values.push(["P", "status", step.status ?? 1]);
    if (step.flow !== null) values.push(["P", "flow_bpd", step.flow ?? 3000]);
    for (const [asset_id, metric, value] of values) readings.push({
      timestamp: new Date(step.ts * 1000).toISOString(), ts_unix: step.ts, asset_id, metric, value
    });
  }
  readings.sort((a, b) => a.ts_unix - b.ts_unix);
  return {
    folder: "synthetic-test-only",
    firstTs: readings[0].ts_unix, nowTs: readings.at(-1)!.ts_unix, readings, latest: new Map(),
    network: {
      defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } },
      systems: [{ id: "S", disposal_site: { id: "D", lat: 0, lon: 0, pressure_psi: 1000 },
        facilities: [{ id: "F", lat: 0, lon: 0,
          wells: [{ id: "W", baseline_water_bpd: 2400, oil_bpd: 24, gas_mcfd: 0 }],
          tank: { id: "T", capacity_bbl: 1000 },
          pump: { id: "P", max_flow_bpd: 3000, start_level_pct: 70, stop_level_pct: 30 },
          pipeline: { id: "L", max_bpd: 4000, max_pressure_psi: 1700 }
        }] }]
    },
    ops: {
      prices: { oil_per_bbl: 60, gas_per_mcf: 3 },
      expected_repair_hours: { pump_failure: 6 },
      emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 },
      systems: { S: { emergency_fleet_size: 2, facilities: { F: { response_min: 75, cycle_min: 240 } } } }
    }
  };
}

test("normal stopped/running cycles do not create failures", () => {
  const d = fixture([{ ts: 0, status: 0, flow: 0 }, { ts: 300, status: 1 }, { ts: 600, status: 0, flow: 0 }]);
  assert.equal(analyzeDataset(d).events.length, 0);
});

test("fault is immediate but ETA waits for enough measurements", () => {
  const d = fixture([0, 300, 600].map((ts, i) => ({ ts, status: 2, flow: 0, level: 50 + i })));
  const first = analyzeDataset(d, 0);
  assert.equal(first.events.length, 1);
  assert.equal(first.predictions[0].state, "insufficient_data");
  assert.equal(first.predictions[0].hoursToShutdown, null);
  const p = analyzeDataset(d).predictions[0];
  assert.equal(p.state, "rising");
  assert.equal(p.netInflowBblPerHour, 100);
  assert.equal(p.hoursToShutdown, 4);
  assert.ok(Math.abs(p.repairRemainingHours - (6 - 600 / 3600)) < 1e-9);
});

test("analysis at an earlier timestamp does not inspect future readings", () => {
  const d = fixture([{ ts: 0 }, { ts: 300, status: 2, flow: 0 }]);
  assert.equal(analyzeDataset(d, 0).events.length, 0);
  assert.equal(analyzeDataset(d, 300).events.length, 1);
});

test("raw shutdown level overrides trend warmup", () => {
  const p = analyzeDataset(fixture([{ ts: 0, status: 2, flow: 0, level: 92 }])).predictions[0];
  assert.equal(p.state, "at_shutdown");
  assert.equal(p.hoursToShutdown, 0);
});

test("stale or incomplete measurements do not receive a current ETA", () => {
  const steps = [0, 300, 600].map(ts => ({ ts, status: 2, flow: 0 }));
  const d = fixture(steps);
  assert.equal(analyzeDataset(d, 1500).predictions[0].state, "stale");
  assert.equal(analyzeDataset(d, 1500).predictions[0].hoursToShutdown, null);
  const missing = fixture([...steps, { ts: 900, status: 2, flow: null }]);
  assert.equal(analyzeDataset(missing).predictions[0].state, "insufficient_data");
});

test("pump recovery resolves the failure event", () => {
  const d = fixture([{ ts: 0, status: 2, flow: 0 }, { ts: 300, status: 0, flow: 0 }]);
  const result = analyzeDataset(d);
  assert.equal(result.events[0].status, "resolved");
  assert.equal(result.events[0].endTs, 300);
  assert.equal(result.alerts.length, 0);
});

test("a gap in one sensor restarts prediction warmup", () => {
  const steps: Step[] = [0, 300, 600].map(ts => ({ ts, status: 2, flow: 0 }));
  steps.push(...[900, 1200, 1500].map(ts => ({ ts, status: 2, flow: null })));
  steps.push({ ts: 1800, status: 2, flow: 0 });
  const p = analyzeDataset(fixture(steps)).predictions[0];
  assert.equal(p.state, "insufficient_data");
  assert.equal(p.sampleCount, 1);
  assert.equal(p.hoursToShutdown, null);
});

test("missing pump status withholds ETA without falsely resolving the fault", () => {
  const steps: Step[] = [0, 300, 600].map(ts => ({ ts, status: 2, flow: 0 }));
  steps.push({ ts: 900, status: null, flow: 0 });
  const result = analyzeDataset(fixture(steps));
  assert.equal(result.alerts.length, 1);
  assert.equal(result.predictions[0].state, "insufficient_data");
  assert.equal(result.predictions[0].hoursToShutdown, null);
});

test("nonpositive net inflow has no finite shutdown ETA", () => {
  const d = fixture([0, 300, 600].map(ts => ({ ts, status: 2, flow: 2500 })));
  const p = analyzeDataset(d).predictions[0];
  assert.equal(p.state, "not_filling");
  assert.equal(p.hoursToShutdown, null);
});

test("degradation followed by failure creates separate events", () => {
  const steps = Array.from({ length: 5 }, (_, i) => ({ ts: i * 300, flow: 2500 }));
  const result = analyzeDataset(fixture([...steps, { ts: 1500, status: 2, flow: 0 }]));
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].category, "pump_degradation");
  assert.equal(result.events[0].status, "resolved");
  assert.equal(result.events[1].category, "pump_failure");
});

test("a persistent flow gap raises one leak event and healthy flow resolves it", () => {
  const steps = Array.from({ length: 15 }, (_, i) => ({
    ts: i * 300, flow: 3000, received: i < 7 ? 2700 : 3000
  }));
  const result = analyzeDataset(fixture(steps));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].category, "pipeline_leak");
  assert.equal(result.events[0].status, "resolved");
  assert.equal(result.predictions.length, 0);
});
