import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDatasetContext,
  detectAlerts,
  parseArduinoSerialOutput,
  parseSerialMessage,
  readArduinoSketch,
  readDatasetFiles,
  validateSerialReading,
} from "./monitor.js";

const dataDirectory = new URL("../HackUTD-ZeroDay-main/history/full_week/", import.meta.url);
const network = JSON.parse(readFileSync(new URL("network.json", dataDirectory), "utf8"));
const ops = JSON.parse(readFileSync(new URL("ops.json", dataDirectory), "utf8"));
const context = createDatasetContext(network, ops);
const facility = network.systems[0].facilities[0];
const system = network.systems[0];

function frame(ts, changes = {}) {
  const values = {
    [facility.tank.id]: { level_pct: 60 },
    [facility.pump.id]: { status: 1, flow_bpd: 3000, discharge_psi: 1200 },
    [facility.pipeline.id]: { pressure_psi: system.disposal_site.pressure_psi + 50 },
    ...changes,
  };
  return Object.entries(values).flatMap(([asset_id, metrics]) => Object.entries(metrics).map(([metric, value]) => ({
    timestamp: new Date(ts * 1000).toISOString(),
    ts_unix: ts,
    asset_id,
    metric,
    value,
  })));
}

function dataset(readings) {
  return { ...context, readings, nowTs: readings.at(-1)?.ts_unix || 0 };
}

function findAlert(readings, category) {
  return detectAlerts(dataset(readings)).find((alert) => alert.category === category);
}

function file(name, contents) {
  const blob = new Blob([contents]);
  Object.defineProperty(blob, "name", { value: name });
  return blob;
}

test("healthy operating readings produce no alerts", () => {
  assert.deepEqual(detectAlerts(dataset(frame(1_800_000_000))), []);
});

test("tank warning and shutdown limits are inclusive", () => {
  assert.equal(findAlert(frame(1_800_000_000, {
    [facility.tank.id]: { level_pct: 85 },
  }), "tank_warning")?.severity, "warning");
  assert.equal(findAlert(frame(1_800_000_000, {
    [facility.tank.id]: { level_pct: 92 },
  }), "tank_shutdown")?.severity, "alarm");
});

test("a direct overflow signal raises a red alert", () => {
  const alert = findAlert(frame(1_800_000_000, {
    [facility.tank.id]: { overflow: 1 },
  }), "tank_overflow");
  assert.equal(alert?.severity, "alarm");
  assert.match(alert.description, /shutdown procedures/);
});

test("pump fault status raises a red alert", () => {
  assert.equal(findAlert(frame(1_800_000_000, {
    [facility.pump.id]: { status: 2, flow_bpd: 0, discharge_psi: 0 },
  }), "pump_failure")?.severity, "alarm");
});

test("sustained pipeline pressure loss raises an alarm", () => {
  const readings = [0, 300, 600].flatMap((offset) => frame(1_800_000_000 + offset, {
    [facility.pipeline.id]: { pressure_psi: system.disposal_site.pressure_psi + 20 },
  }));
  assert.equal(findAlert(readings, "pipeline_leak")?.severity, "alarm");
});

test("sustained low pump discharge pressure raises a warning", () => {
  const readings = [0, 300, 600].flatMap((offset) => frame(1_800_000_000 + offset, {
    [facility.pump.id]: { status: 1, flow_bpd: 3000, discharge_psi: 1190 },
  }));
  assert.equal(findAlert(readings, "pump_degradation")?.severity, "warning");
});

test("serial parser and asset validation reject malformed input", () => {
  assert.throws(() => parseSerialMessage("{"), SyntaxError);
  assert.throws(() => parseSerialMessage('{"asset_id":"S1_TANK_A","metric":"level_pct","value":"90","ts_unix":1}'), /finite JSON number/);
  assert.throws(() => parseSerialMessage('{"asset_id":"S1_TANK_A","metric":"level_pct","value":90,"ts_unix":1,"timestamp":"2026-10-05T00:00:00Z"}'), /match ts_unix/);
  const validOverflow = parseSerialMessage('{"asset_id":"S1_TANK_A","metric":"overflow","value":1,"ts_unix":1}');
  assert.doesNotThrow(() => validateSerialReading(context, validOverflow));
  const reading = parseSerialMessage('{"asset_id":"S1_TANK_A","metric":"overflow","value":2,"ts_unix":1}');
  assert.throws(() => validateSerialReading(context, reading), /0 or 1/);
  assert.throws(() => validateSerialReading(context, {
    asset_id: "unknown",
    metric: "overflow",
    value: 1,
    ts_unix: 1,
  }), /known asset_id/);
});

test("Arduino serial output maps overflow to red and normal states to clear", () => {
  const options = { tankId: facility.tank.id, tsUnix: 1_800_000_000 };
  const overflow = parseArduinoSerialOutput("Overflow detected", options);
  const normal = parseArduinoSerialOutput("Status: GREEN", options);
  const noOverflow = parseArduinoSerialOutput("No overflow", options);
  const level = parseArduinoSerialOutput("Tank level: 42%", options);
  assert.deepEqual([overflow.metric, overflow.value], ["overflow", 1]);
  assert.deepEqual([normal.metric, normal.value], ["overflow", 0]);
  assert.deepEqual([noOverflow.metric, noOverflow.value], ["overflow", 0]);
  assert.deepEqual([level.metric, level.value], ["level_pct", 42]);
  assert.equal(findAlert(frame(options.tsUnix, {
    [facility.tank.id]: { overflow: overflow.value },
  }), "tank_overflow")?.severity, "alarm");
  assert.equal(findAlert(frame(options.tsUnix, {
    [facility.tank.id]: { overflow: normal.value, level_pct: 35 },
  }), "tank_overflow"), undefined);
  assert.throws(() => parseArduinoSerialOutput("Distance: 24 cm", options), /Unrecognized Arduino output/);
});

test("Arduino sketch loader accepts .ino source without executing it", async () => {
  const sketch = await readArduinoSketch(file("overflow_sensor.ino", "void setup() {}\nvoid loop() {}"));
  assert.equal(sketch.name, "overflow_sensor.ino");
  await assert.rejects(readArduinoSketch(file("sensor.txt", "void setup() {}")), /\.ino extension/);
  await assert.rejects(readArduinoSketch(file("empty.ino", "")), /empty or is not valid text/);
});

test("the documented history files load and validate as runtime telemetry", async () => {
  const telemetry = readFileSync(new URL("telemetry.csv", dataDirectory), "utf8");
  const loaded = await readDatasetFiles([
    file("network.json", JSON.stringify(network)),
    file("ops.json", JSON.stringify(ops)),
    file("telemetry.csv", telemetry),
  ]);
  assert.ok(loaded.readings.length > 1000);
  assert.equal(loaded.nowTs, loaded.readings.at(-1).ts_unix);
  assert.ok(Array.isArray(detectAlerts(loaded)));
});

test("dataset loader requires every input file", async () => {
  await assert.rejects(readDatasetFiles([file("network.json", "{}")]), /ops.json, telemetry.csv/);
});

test("dataset loader rejects blank readings and duplicate filenames", async () => {
  const csv = "timestamp,ts_unix,asset_id,metric,value\n2026-10-05T00:00:00Z,1791158400,S1_TANK_A,level_pct,";
  const inputs = [
    file("network.json", JSON.stringify(network)),
    file("ops.json", JSON.stringify(ops)),
    file("telemetry.csv", csv),
  ];
  await assert.rejects(readDatasetFiles(inputs), /Invalid telemetry record on CSV line 2/);
  await assert.rejects(readDatasetFiles([...inputs, file("network.json", JSON.stringify(network))]), /one copy of each data file/);
});
