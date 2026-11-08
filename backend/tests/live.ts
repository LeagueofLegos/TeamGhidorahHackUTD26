import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { openSync, mkdirSync, closeSync } from "node:fs";
process.env.SPACETIME_URI = "ws://127.0.0.1:3100";
process.env.SPACETIME_DATABASE = `ghidorah-test-${randomUUID().slice(0, 8)}`;
process.env.SPACETIME_ROOT = resolve(".runtime-live");
const { cli, httpOrigin, startServer, stopProcess, database } = await import(
  "../scripts/cli.js"
);
const { connectNode } = await import("../scripts/connection.js");
const { connect, onSnapshot } = await import("../client/connect.js");
const { importDataset, configure, DEFAULT_FOLDER } = await import(
  "../scripts/import.js"
);
const { DEFAULT_COMPRESSOR } = await import("../src/demo.js");
const { DEFAULT_FIELD_POLICY } = await import("../src/field_control.js");
const { allAtRiskFrames } = await import("../src/demo_frames.js");
async function until(predicate: () => boolean, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error("Subscription update timed out");
    await delay(50);
  }
}
// Own a dedicated loopback port, database name and runtime directory; never delete an existing database.
let server: ReturnType<typeof startServer> | undefined;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
try {
  try {
    await fetch(`${httpOrigin}/v1/ping`, { signal: AbortSignal.timeout(500) });
    throw new Error(
      "Port 3100 is already in use. Stop that test server first.",
    );
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }
  mkdirSync(".runtime-live", { recursive: true });
  const fd = openSync(".runtime-live/test-server.log", "a");
  server = startServer({ stdio: ["ignore", fd, fd] });
  closeSync(fd);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${httpOrigin}/v1/ping`)).ok) break;
    } catch {}
    if (i >= 100 || server.exitCode !== null)
      throw new Error("Test server did not start");
    await delay(200);
  }
  cli([
    "publish",
    "--server",
    httpOrigin,
    "--module-path",
    "spacetimedb",
    "--yes=skip-login",
    database,
  ]);
  const writer = await connectNode(true);
  connections.push(writer);
  const reader = await connect({ uri: process.env.SPACETIME_URI, database });
  connections.push(reader);
  await assert.rejects(
    reader.reducers.acknowledgeAlert({ id: "anything" }),
    /authorization/i,
  );
  let notifications = 0;
  const unsubscribe = onSnapshot(reader, () => notifications++);
  await importDataset(writer, DEFAULT_FOLDER);
  await until(() => reader.db.appState.id.find("main")?.status === "ready");
  const plan = reader.db.recommendation.id.find("S2")!;
  assert.equal(plan.status, "planned");
  assert.ok(Math.abs(plan.totalCost! - 3120.94) < 0.01);
  assert.ok(reader.db.entity.id.find("S1_TANK_A"));
  assert.ok(reader.db.edge.count() > 100n);
  assert.equal(
    [...reader.db.event.iter()].filter((e) => e.status === "ongoing").length,
    6,
  );
  assert.ok(notifications > 1, "Live frontend callback receives updates");
  await writer.reducers.compareScenario({
    id: "without-trucks",
    json: '{"fleetSize":0}',
  });
  await until(() => !!reader.db.scenario.id.find("without-trucks"));
  assert.equal(
    reader.db.recommendation.id.find("S2")?.totalCost,
    plan.totalCost,
  );
  await writer.reducers.recordDecision({
    systemId: "S2",
    revision: plan.revision,
    note: "Reviewed advisory for hackathon demo",
  });
  await until(() =>
    [...reader.db.audit.iter()].some((a) => a.action === "advisory_decision"),
  );
  console.log(
    "PASS snapshot subscriptions, graph, $3120.94 fleet plan, scenario isolation, audit, reader authorization",
  );
  await writer.reducers.setFieldPolicy({
    json: JSON.stringify({
      ...DEFAULT_FIELD_POLICY,
      avoidableOperatingCostPerHour: 100000,
    }),
  });
  await until(() => reader.db.fieldControl.id.find("FIELD")?.tripped === true);
  assert.equal(
    reader.db.fieldControl.id.find("FIELD")?.reason,
    "lowest_modeled_cost",
  );
  assert.equal(
    [...reader.db.wellProduction.iter()].filter(
      (w) => w.deliveredOilBpd === 0 && w.deliveredGasMcfd === 0,
    ).length,
    45,
  );
  assert.equal(
    reader.db.sensorCurrent.id.find(JSON.stringify(["S1_WELL_A1", "status"]))
      ?.value,
    1,
  );
  await writer.reducers.setFieldPolicy({
    json: JSON.stringify(DEFAULT_FIELD_POLICY),
  });
  await writer.reducers.resetField({
    revision: writer.db.appState.id.find("main")!.revision,
    reason: "Reviewed cleared economic trigger in live integration test",
  });
  await until(() => reader.db.fieldControl.id.find("FIELD")?.tripped === false);
  console.log(
    "PASS automatic economic shutdown, all 45 wells off, source preservation, and reviewed restart",
  );
  const { session } = await configure(writer, DEFAULT_FOLDER, "mock");
  for (let i = 0; i < 5; i++) {
    await writer.reducers.ingestHardware({
      json: JSON.stringify({
        session,
        deviceId: "UNO_R4",
        sequence: i,
        observedAtMs: Date.now(),
        levelPct: 60 + i * 3,
        wet: false,
        tilt: false,
        shock: false,
      }),
    });
    if (i < 4) await delay(1050);
  }
  await until(
    () => reader.db.hardwarePrediction.id.find("UNO_R4")?.state === "rising",
  );
  assert.ok(
    reader.db.hardwarePrediction.id.find("UNO_R4")!.secondsToThreshold! > 0,
  );
  await writer.reducers
    .ingestHardware({
      json: JSON.stringify({
        session,
        deviceId: "UNO_R4",
        sequence: 4,
        observedAtMs: Date.now(),
        levelPct: 75,
        wet: false,
        tilt: false,
        shock: false,
      }),
    })
    .then(
      () => assert.fail("Duplicate accepted"),
      () => {},
    );
  await delay(150);
  await writer.reducers.ingestHardware({
    json: JSON.stringify({
      session,
      deviceId: "UNO_R4",
      sequence: 5,
      observedAtMs: Date.now(),
      levelPct: null,
      wet: true,
      tilt: false,
      shock: false,
    }),
  });
  await until(
    () => reader.db.hardwarePrediction.id.find("UNO_R4")?.state === "invalid",
  );
  assert.equal(reader.db.recommendation.count(), 0n);
  await delay(150);
  await writer.reducers.ingestHardware({
    json: JSON.stringify({
      session,
      deviceId: "UNO_R4",
      sequence: 6,
      observedAtMs: Date.now(),
      levelPct: 93,
      wet: true,
      tilt: true,
      shock: true,
    }),
  });
  await until(
    () => reader.db.compressorState.id.find("DEMO_C101")?.tripped === true,
  );
  assert.equal(
    reader.db.compressorState.id.find("DEMO_C101")?.deferredMcfd,
    9000,
  );
  await writer.reducers.acknowledgeAlert({ id: "DEMO_C101/trip" });
  await writer.reducers.simulateCompressor({
    tripped: false,
    configJson: JSON.stringify({ ...DEFAULT_COMPRESSOR, horizonHours: 4 }),
  });
  assert.equal(writer.db.compressorState.id.find("DEMO_C101")?.tripped, true);
  await until(
    () => reader.db.appState.id.find("main")?.status === "stale",
    14000,
  );
  assert.equal(
    reader.db.hardwarePrediction.id.find("UNO_R4")?.secondsToThreshold,
    undefined,
  );
  assert.equal(reader.db.recommendation.count(), 0n);
  assert.equal(reader.db.compressorState.id.find("DEMO_C101")?.tripped, true);
  assert.equal(reader.db.alert.id.find("DEMO_C101/trip")?.acknowledged, true);
  console.log(
    "PASS real-time smoothing, invalid/duplicate rejection, latched six-well trip, scheduled stale-data handling",
  );
  const full = await configure(
    writer,
    DEFAULT_FOLDER,
    "replay",
    undefined,
    "Synthetic counterfactual: all facilities at risk",
  );
  await writer.reducers.ingestFrames({
    session: full.session,
    json: JSON.stringify(
      allAtRiskFrames(full.dataset.network, Math.floor(Date.now() / 1000)),
    ),
  });
  await writer.reducers.finishImport({ session: full.session });
  await until(
    () =>
      reader.db.fieldControl.id.find("FIELD")?.reason ===
      "all_producing_facilities_at_risk",
  );
  assert.equal(reader.db.warningForecast.count(), 15n);
  assert.ok(
    [...reader.db.warningForecast.iter()].every(
      (p) => p.hoursToShutdown !== undefined && p.hoursToShutdown > 0,
    ),
  );
  await assert.rejects(
    writer.reducers.resetField({
      revision: writer.db.appState.id.find("main")!.revision,
      reason: "Attempt while all-at-risk condition remains",
    }),
    /still active/,
  );
  assert.ok(
    [...reader.db.wellProduction.iter()].every((w) => w.deliveredOilBpd === 0),
  );
  console.log(
    "PASS all-at-risk automatic field stop, warning countdowns, latch and rejected premature restart",
  );
  unsubscribe();
  console.log("LIVE INTEGRATION PASSED");
} finally {
  for (const c of connections) c.disconnect();
  stopProcess(server);
}
