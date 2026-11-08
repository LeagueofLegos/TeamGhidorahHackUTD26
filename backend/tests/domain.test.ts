import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LineFramer, parseTelemetry } from "../bridge/protocol.js";
import {
  predictLevel,
  compressorComparison,
  DEFAULT_COMPRESSOR,
} from "../src/demo.js";
import { infer, validateModel, type Model } from "../src/ml.js";
import {
  createAnalysisState,
  advanceAnalysisFrame,
  summarizeAnalysis,
  analyzeDataset,
} from "../src/detection.js";
import { fixture } from "./fixture.js";
test("bounded serial framing resynchronizes after malformed/oversized input", () => {
  const lines: string[] = [],
    errors: string[] = [];
  const f = new LineFramer(
    (line) => lines.push(line),
    (e) => errors.push(e),
  );
  f.push("x".repeat(2000));
  f.push('\n{"a":');
  f.push("1}\r\n");
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(errors.length, 1);
  assert.throws(() =>
    parseTelemetry('{"device_id":"UNO_R4","water_level_pct":null}'),
  );
  assert.equal(
    parseTelemetry(
      '{"device_id":"UNO_R4","water_level_pct":null,"wet":false,"tilt":false,"shock":true}',
    ).water_level_pct,
    null,
  );
});
test("physical trend handles smoothing warmup, gaps, draining, raw threshold and stale data", () => {
  const samples = [60, 62, 64, 66, 68].map((levelPct, i) => ({
    levelPct,
    atMs: i * 1000,
  }));
  assert.equal(
    predictLevel(samples.slice(0, 2), 1000, 92).state,
    "insufficient_data",
  );
  assert.equal(predictLevel(samples, 4000, 92).state, "rising");
  assert.equal(predictLevel(samples, 15000, 92).secondsToThreshold, null);
  assert.equal(
    predictLevel([...samples, { levelPct: 92, atMs: 5000 }], 5000, 92)
      .secondsToThreshold,
    0,
  );
  assert.equal(
    predictLevel(
      samples.map((s) => ({ ...s, levelPct: 100 - s.levelPct })),
      4000,
      92,
    ).state,
    "not_rising",
  );
  assert.equal(
    predictLevel([...samples, { levelPct: 70, atMs: 11000 }], 11000, 92).state,
    "insufficient_data",
  );
});
test("ML artifact enforces chronological availability, finite scores, and correct dimensions", () => {
  const m = JSON.parse(readFileSync("models/anomaly.json", "utf8")) as Model;
  validateModel(m);
  assert.equal(
    infer(m, [1, 0, 1, 1,1,0,1,1].slice(0,m.features.length), m.trainedThroughTs).state,
    "before_training_cutoff",
  );
  const result = infer(m, [1, 0, 1, 1,1,0,1,1].slice(0,m.features.length), m.trainedThroughTs + 300);
  assert.equal(result.label, "normal");
  assert.ok(Math.abs(result.scores!.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.throws(() => infer(m, [NaN, 0, 0, 0], m.trainedThroughTs + 1));
  assert.throws(() => validateModel({ ...m, scales: [0, 1, 1, 1] }));
});
test("compressor costs use hourly rates, feasibility and finite configurable horizons", () => {
  const c = compressorComparison(
    { ...DEFAULT_COMPRESSOR, horizonHours: 4, standbyAvailable: false },
    true,
  );
  assert.equal(c[0].totalCost, 4500);
  assert.equal(c[1].feasible, false);
  assert.equal(compressorComparison(DEFAULT_COMPRESSOR, false)[0].totalCost, 0);
  assert.throws(() =>
    compressorComparison({ ...DEFAULT_COMPRESSOR, horizonHours: 0 }, true),
  );
});
test("incremental detector survives JSON persistence and matches batch event recovery", () => {
  const d = fixture();
  let state = createAnalysisState(d.network),
    cursor = 0;
  while (cursor < d.readings.length) {
    const ts = d.readings[cursor].ts_unix,
      rows = [];
    while (cursor < d.readings.length && d.readings[cursor].ts_unix === ts)
      rows.push(d.readings[cursor++]);
    advanceAnalysisFrame(state, rows);
    state = JSON.parse(JSON.stringify(state));
  }
  assert.deepEqual(summarizeAnalysis(state, d), analyzeDataset(d));
  assert.equal(state.events[0].status, "resolved");
});
