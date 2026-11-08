import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ConnectionId, Timestamp } from "spacetimedb";
import {
  createModuleTestHarness,
  TestAuth,
} from "spacetimedb/server/test-utils";
import schema, * as mod from "../spacetimedb/src/index.js";
import { DEFAULT_COMPRESSOR } from "../src/demo.js";
import { DEFAULT_FIELD_POLICY } from "../src/field_control.js";
import { allAtRiskFrames } from "../src/demo_frames.js";
const owner = TestAuth.fromJwtPayload(
  JSON.stringify({ iss: "test", sub: "owner" }),
  new ConnectionId(1n),
);
const stranger = TestAuth.fromJwtPayload(
  JSON.stringify({ iss: "test", sub: "stranger" }),
  new ConnectionId(2n),
);
const network = JSON.parse(
  readFileSync("data/HackUTD-ZeroDay/history/full_week/network.json", "utf8"),
);
const ops = JSON.parse(
  readFileSync("data/HackUTD-ZeroDay/history/full_week/ops.json", "utf8"),
);
const model = JSON.parse(readFileSync("models/anomaly.json", "utf8"));
function setup(mode = "mock") {
  const h = createModuleTestHarness(schema, mod);
  h.clock.set(new Timestamp(1791800000000000n));
  h.withReducerTx(owner, (ctx) => mod.init(ctx, {}));
  h.withReducerTx(owner, (ctx) =>
    mod.configure_session(ctx, {
      json: JSON.stringify({
        network,
        ops,
        mode,
        session: "test",
        source: "unit-test",
        model,
      }),
    }),
  );
  return h;
}
type H = ReturnType<typeof setup>;
function send(h: H, level: number | null, i: number, extra = {}) {
  const at = 1791800000000 + i * 1000;
  h.clock.set(new Timestamp(BigInt(at) * 1000n));
  h.withReducerTx(owner, (ctx) =>
    mod.ingest_hardware(ctx, {
      json: JSON.stringify({
        session: "test",
        deviceId: "UNO_R4",
        sequence: i,
        observedAtMs: at,
        levelPct: level,
        wet: false,
        tilt: false,
        shock: false,
        ...extra,
      }),
    }),
  );
}
describe("authoritative SpacetimeDB reducers", () => {
  it("complete field protection also covers usable warning forecasts without inventing pump faults", () => {
    const h = setup("replay"),
      rows = allAtRiskFrames(network, 1791800000).map((frame) =>
        frame.map((r) =>
          r.metric === "status" && r.asset_id.includes("PUMP")
            ? { ...r, value: 0 }
            : r,
        ),
      );
    h.withReducerTx(owner, (ctx) =>
      mod.ingest_frames(ctx, { session: "test", json: JSON.stringify(rows) }),
    );
    h.withReducerTx(owner, (ctx) =>
      mod.finish_import(ctx, { session: "test" }),
    );
    expect(h.db.event.count()).toBe(0n);
    expect(h.db.warningForecast.count()).toBe(15n);
    expect(h.db.fieldControl.id.find("FIELD")?.tripped).toBe(true);
    expect(h.db.fieldControl.id.find("FIELD")?.reason).toBe(
      "all_producing_facilities_at_risk",
    );
  });
  it("gives warning-to-shutdown ETA with enough fresh flow history", () => {
    const h = setup();
    send(h, 85, 0);
    expect(h.db.warningForecast.id.find("S1_TANK_A")?.state).toBe(
      "insufficient_data",
    );
    send(h, 86, 1);
    send(h, 87, 2);
    expect(
      h.db.warningForecast.id.find("S1_TANK_A")?.hoursToShutdown,
    ).toBeCloseTo(0.6);
  });
  it("automatically latches economic field shutdown, preserves source readings, and permits only a reviewed fresh restart", () => {
    const h = setup();
    send(h, 60, 0);
    h.withReducerTx(owner, (ctx) =>
      mod.set_field_policy(ctx, {
        json: JSON.stringify({
          ...DEFAULT_FIELD_POLICY,
          avoidableOperatingCostPerHour: 100000,
        }),
      }),
    );
    expect(h.db.fieldControl.id.find("FIELD")?.tripped).toBe(true);
    expect(h.db.fieldControl.id.find("FIELD")?.reason).toBe(
      "lowest_modeled_cost",
    );
    expect([...h.db.wellProduction.iter()]).toHaveLength(45);
    expect(
      [...h.db.wellProduction.iter()].every(
        (w) => w.deliveredOilBpd === 0 && w.deliveredGasMcfd === 0,
      ),
    ).toBe(true);
    expect(
      h.db.sensorCurrent.id.find(JSON.stringify(["S2_WELL_A1", "status"]))
        ?.value,
    ).toBe(1);
    h.withReducerTx(owner, (ctx) =>
      mod.acknowledge_alert(ctx, { id: "FIELD/shutdown" }),
    );
    expect(h.db.fieldControl.id.find("FIELD")?.tripped).toBe(true);
    const revision = h.db.appState.id.find("main")!.revision;
    expect(() =>
      h.withReducerTx(owner, (ctx) =>
        mod.reset_field(ctx, {
          revision,
          reason: "Trying to restart while the same condition is active",
        }),
      ),
    ).toThrow("still active");
    h.withReducerTx(owner, (ctx) =>
      mod.set_field_policy(ctx, { json: JSON.stringify(DEFAULT_FIELD_POLICY) }),
    );
    const updated = h.db.appState.id.find("main")!.revision;
    expect(() =>
      h.withReducerTx(stranger, (ctx) =>
        mod.reset_field(ctx, {
          revision: updated,
          reason: "Unapproved reader",
        }),
      ),
    ).toThrow("authorization");
    h.withReducerTx(owner, (ctx) =>
      mod.reset_field(ctx, {
        revision: updated,
        reason:
          "Reviewed zero operating-cost assumption and cleared economic trigger",
      }),
    );
    expect(h.db.fieldControl.id.find("FIELD")?.tripped).toBe(false);
  });
  it("all producing facilities at risk triggers complete field shutdown and persists across subsequent updates", () => {
    const h = setup("replay"),
      rows = allAtRiskFrames(network, 1791800000);
    h.withReducerTx(owner, (ctx) =>
      mod.ingest_frames(ctx, { session: "test", json: JSON.stringify(rows) }),
    );
    h.withReducerTx(owner, (ctx) =>
      mod.finish_import(ctx, { session: "test" }),
    );
    expect(h.db.fieldControl.id.find("FIELD")?.reason).toBe(
      "all_producing_facilities_at_risk",
    );
    expect(
      [...h.db.wellProduction.iter()].every(
        (w) => w.state === "field_shutdown",
      ),
    ).toBe(true);
    const revision = h.db.appState.id.find("main")!.revision;
    expect(() =>
      h.withReducerTx(owner, (ctx) =>
        mod.reset_field(ctx, {
          revision: revision - 1,
          reason: "Outdated reset",
        }),
      ),
    ).toThrow("revision");
  });
  it("seeds graph relationships, six separate compressor wells, model metadata and a scheduler", () => {
    const h = setup();
    expect(h.db.entity.id.find("S1_WELL_A1")?.kind).toBe("well");
    expect(
      [...h.db.entity.iter()].filter((r) => r.kind === "gas_well"),
    ).toHaveLength(6);
    expect(h.db.edge.count()).toBeGreaterThan(100n);
    expect(h.db.tick.count()).toBe(1n);
    expect(h.db.modelInfo.id.find("anomaly")?.trainedThroughTs).toBeGreaterThan(
      0,
    );
  });
  it("rejects anonymous readers changing configuration or acknowledging alerts", () => {
    const h = setup();
    expect(() =>
      h.withReducerTx(stranger, (ctx) =>
        mod.configure_session(ctx, { json: "{}" }),
      ),
    ).toThrow("authorization");
    expect(() =>
      h.withReducerTx(stranger, (ctx) =>
        mod.acknowledge_alert(ctx, { id: "x" }),
      ),
    ).toThrow("authorization");
  });
  it("warms up smoothed physical ETA separately from field-hour predictions", () => {
    const h = setup();
    send(h, 60, 0);
    expect(
      h.db.hardwarePrediction.id.find("UNO_R4")?.secondsToThreshold,
    ).toBeUndefined();
    [62, 64, 66, 68].forEach((v, i) => send(h, v, i + 1));
    expect(h.db.hardwarePrediction.id.find("UNO_R4")?.state).toBe("rising");
    expect(
      h.db.prediction.id.find("S1_FACILITY_A")?.hoursToShutdown,
    ).toBeGreaterThan(0);
    expect(h.db.recommendation.id.find("S1")?.advisoryOnly).toBe(true);
  });
  it("invalid level clears ETA/recommendations without inventing a zero level", () => {
    const h = setup();
    [60, 61, 62, 63, 64].forEach((v, i) => send(h, v, i));
    send(h, null, 5, { wet: true });
    expect(h.db.hardwarePrediction.id.find("UNO_R4")?.state).toBe("invalid");
    expect(h.db.hardwareStatus.id.find("UNO_R4")?.levelPct).toBeUndefined();
    expect(h.db.recommendation.count()).toBe(0n);
    send(h, 66, 6);
    expect(h.db.hardwarePrediction.id.find("UNO_R4")?.state).toBe(
      "insufficient_data",
    );
  });
  it("threshold trips fictional production and remains latched after draining and acknowledgement", () => {
    const h = setup();
    send(h, 92, 0);
    expect(h.db.compressorState.id.find("DEMO_C101")?.deferredMcfd).toBe(9000);
    h.withReducerTx(owner, (ctx) =>
      mod.acknowledge_alert(ctx, { id: "DEMO_C101/trip" }),
    );
    send(h, 40, 1);
    expect(h.db.compressorState.id.find("DEMO_C101")?.tripped).toBe(true);
    expect(h.db.alert.id.find("DEMO_C101/trip")?.acknowledged).toBe(true);
    expect(
      h.db.sensorCurrent.id.find(JSON.stringify(["S1_WELL_A1", "status"]))
        ?.value,
    ).toBe(0);
  });
  it("rejects duplicate sequence, bad session, old timestamp and impossible sensor values atomically", () => {
    const h = setup();
    send(h, 60, 0);
    for (const extra of [
      { sequence: 0 },
      { session: "old" },
      { levelPct: 101 },
      { observedAtMs: 0 },
      { observedAtMs: 1791800000000 },
      { wet: 1 },
    ])
      expect(() => send(h, 61, 1, extra)).toThrow();
    expect(h.db.hardwareStatus.id.find("UNO_R4")?.sequence).toBe(0);
  });
  it("snapshot import rejects backward timestamps and hardware source mixing", () => {
    const h = setup("replay");
    expect(() => send(h, 60, 0)).toThrow("Switch");
    const r = {
      timestamp: new Date(1791800000 * 1000).toISOString(),
      ts_unix: 1791800000,
      asset_id: "S1_TANK_A",
      metric: "level_pct",
      value: 60,
    };
    h.withReducerTx(owner, (ctx) =>
      mod.ingest_frames(ctx, { session: "test", json: JSON.stringify([[r]]) }),
    );
    expect(() =>
      h.withReducerTx(owner, (ctx) =>
        mod.ingest_frames(ctx, {
          session: "test",
          json: JSON.stringify([[r]]),
        }),
      ),
    ).toThrow("increasing");
    h.withReducerTx(owner, (ctx) =>
      mod.finish_import(ctx, { session: "test" }),
    );
    expect(h.db.appState.id.find("main")?.status).toBe("ready");
  });
  it("compares horizon-dependent compressor actions without changing observed production", () => {
    const h = setup();
    h.withReducerTx(owner, (ctx) =>
      mod.simulate_compressor(ctx, {
        tripped: true,
        configJson: JSON.stringify({
          ...DEFAULT_COMPRESSOR,
          standbyAvailable: false,
          horizonHours: 4,
        }),
      }),
    );
    expect(h.db.compressorAction.id.find("standby_compressor")?.feasible).toBe(
      false,
    );
    expect(h.db.compressorAction.id.find("curtailment")?.totalCost).toBe(4500);
    expect(h.db.sensorCurrent.count()).toBe(0n);
  });
  it("scenario uses a copy and rejects stale decision revisions", () => {
    const h = setup();
    send(h, 70, 0);
    const before = h.db.recommendation.id.find("S1")!;
    h.withReducerTx(owner, (ctx) =>
      mod.compare_scenario(ctx, {
        id: "no-trucks",
        json: '{"fleetSize":0,"repairHours":8}',
      }),
    );
    expect(h.db.recommendation.id.find("S1")?.json).toBe(before.json);
    h.withReducerTx(owner, (ctx) =>
      mod.record_decision(ctx, {
        systemId: "S1",
        revision: before.revision,
        note: "Demo operator reviewed this plan",
      }),
    );
    send(h, 71, 1);
    expect(() =>
      h.withReducerTx(owner, (ctx) =>
        mod.record_decision(ctx, {
          systemId: "S1",
          revision: before.revision,
          note: "Old plan",
        }),
      ),
    ).toThrow("current");
  });
});
