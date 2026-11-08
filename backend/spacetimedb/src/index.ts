import {
  schema,
  table,
  t,
  SenderError,
  type ReducerCtx,
} from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import { validateConfiguration } from "../../src/configuration.js";
import type {
  Network,
  Operations,
  Reading,
  Dataset,
} from "../../src/dataset.js";
import {
  createAnalysisState,
  advanceAnalysisFrame,
  summarizeAnalysis,
  type AnalysisState,
} from "../../src/detection.js";
import { planDataset } from "../../src/planning_dataset.js";
import {
  createMLContext,
  advanceMLContext,
  contextFeatures,
  infer,
  validateModel,
  type Model,
  type MLContext,
} from "../../src/ml.js";
import {
  createTankContext,
  advanceTankContext,
  warningForecasts,
  type TankContext,
} from "../../src/warning_forecast.js";
import {
  DEFAULT_FIELD_POLICY,
  validateFieldPolicy,
  evaluateField,
  type FieldPolicy,
} from "../../src/field_control.js";
import type { PlanningReport } from "../../src/planning_dataset.js";
import {
  DEMO_NOTICE,
  predictLevel,
  DEFAULT_COMPRESSOR,
  SIX_WELLS,
  compressorComparison,
  type LevelSample,
  type CompressorConfig,
} from "../../src/demo.js";

const writer = table(
  {},
  { identity: t.identity().primaryKey(), admin: t.bool() },
);
const runtime = table({}, { id: t.string().primaryKey(), json: t.string() });
const appState = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    revision: t.u32(),
    mode: t.string(),
    session: t.string(),
    source: t.string(),
    status: t.string(),
    modelTs: t.f64(),
    receivedMs: t.f64(),
    notice: t.string(),
  },
);
const entity = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    kind: t.string(),
    systemId: t.string(),
    facilityId: t.string(),
    label: t.string(),
    lat: t.f64(),
    lon: t.f64(),
    json: t.string(),
    simulated: t.bool(),
  },
);
const edge = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    fromId: t.string(),
    toId: t.string(),
    relation: t.string(),
  },
);
const sensorCurrent = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    assetId: t.string(),
    metric: t.string(),
    value: t.f64(),
    observedTs: t.f64(),
    receivedMs: t.f64(),
    provenance: t.string(),
  },
);
const sensorReading = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    assetId: t.string(),
    metric: t.string(),
    value: t.f64(),
    observedTs: t.f64(),
    receivedMs: t.f64(),
    provenance: t.string(),
  },
);
const event = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    facilityId: t.string(),
    assetId: t.string(),
    category: t.string(),
    status: t.string(),
    onsetTs: t.f64(),
    json: t.string(),
  },
);
const alert = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    assetId: t.string(),
    severity: t.string(),
    message: t.string(),
    acknowledged: t.bool(),
    json: t.string(),
  },
);
const prediction = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    state: t.string(),
    hoursToShutdown: t.option(t.f64()),
    json: t.string(),
  },
);
const recommendation = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    status: t.string(),
    totalCost: t.option(t.f64()),
    savings: t.option(t.f64()),
    revision: t.u32(),
    json: t.string(),
    advisoryOnly: t.bool(),
  },
);
const mlInference = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    state: t.string(),
    label: t.option(t.string()),
    json: t.string(),
  },
);
const modelInfo = table(
  { public: true },
  { id: t.string().primaryKey(), trainedThroughTs: t.f64(), json: t.string() },
);
const hardwareStatus = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    quality: t.string(),
    levelPct: t.option(t.f64()),
    sequence: t.u32(),
    receivedMs: t.f64(),
    json: t.string(),
  },
);
const hardwarePrediction = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    state: t.string(),
    secondsToThreshold: t.option(t.f64()),
    json: t.string(),
  },
);
const scenario = table(
  { public: true },
  { id: t.string().primaryKey(), baseRevision: t.u32(), json: t.string() },
);
const audit = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    atMs: t.f64(),
    actor: t.string(),
    action: t.string(),
    json: t.string(),
  },
);
const compressorState = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    tripped: t.bool(),
    deferredMcfd: t.f64(),
    json: t.string(),
  },
);
const compressorAction = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    feasible: t.bool(),
    totalCost: t.f64(),
    json: t.string(),
  },
);
const fieldControl = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    state: t.string(),
    tripped: t.bool(),
    reason: t.string(),
    revision: t.u32(),
    json: t.string(),
  },
);
const wellProduction = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    systemId: t.string(),
    facilityId: t.string(),
    state: t.string(),
    deliveredOilBpd: t.option(t.f64()),
    deliveredGasMcfd: t.option(t.f64()),
    deliveredWaterBpd: t.option(t.f64()),
    json: t.string(),
  },
);
const assetOperation = table(
  { public: true },
  { id: t.string().primaryKey(), state: t.string(), json: t.string() },
);
const warningForecast = table(
  { public: true },
  {
    id: t.string().primaryKey(),
    facilityId: t.string(),
    state: t.string(),
    hoursToShutdown: t.option(t.f64()),
    json: t.string(),
  },
);
const tick = table(
  {},
  { id: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);
const db = schema({
  writer,
  runtime,
  appState,
  entity,
  edge,
  sensorCurrent,
  sensorReading,
  event,
  alert,
  prediction,
  recommendation,
  mlInference,
  modelInfo,
  hardwareStatus,
  hardwarePrediction,
  scenario,
  audit,
  compressorState,
  compressorAction,
  fieldControl,
  wellProduction,
  assetOperation,
  warningForecast,
  tick,
});
export default db;
type Ctx = ReducerCtx<typeof db.schemaType>;
type State = {
  network: Network;
  ops: Operations;
  analysis: AnalysisState;
  mode: string;
  session: string;
  source: string;
  loading: boolean;
  revision: number;
  receivedMs: number;
  mapping: string;
  sequence: number;
  hardwareSamples: LevelSample[];
  virtualStep: number;
  trip: boolean;
  model?: Model;
  compressor: CompressorConfig;
  compressorTripped: boolean;
  mlContext?: MLContext;
  tankContext?: TankContext;
  fieldPolicy?: FieldPolicy;
  fieldTrip?: {
    reason: string;
    atTs: number;
    atMs: number;
    decision: ReturnType<typeof evaluateField>;
  };
};
const ms = (ctx: Ctx) => Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
function auth(ctx: Ctx, admin = false) {
  const w = ctx.db.writer.identity.find(ctx.sender);
  if (!w || (admin && !w.admin))
    throw new SenderError(
      "Writer authorization required. Ask the local database publisher to grant_writer.",
    );
}
function state(ctx: Ctx): State {
  const r = ctx.db.runtime.id.find("main");
  if (!r) throw new SenderError("Configure a session first");
  const s = JSON.parse(r.json) as State;
  s.mlContext ??= createMLContext();
  s.tankContext ??= createTankContext();
  s.fieldPolicy ??= { ...DEFAULT_FIELD_POLICY };
  return s;
}
function advanceFrame(s: State, rows: Reading[]) {
  advanceAnalysisFrame(s.analysis, rows);
  advanceMLContext((s.mlContext ??= createMLContext()), s.network, rows);
  advanceTankContext((s.tankContext ??= createTankContext()), s.network, rows);
}
function save(ctx: Ctx, s: State, status: string) {
  put(ctx.db.runtime, { id: "main", json: JSON.stringify(s) });
  put(ctx.db.appState, {
    id: "main",
    revision: s.revision,
    mode: s.mode,
    session: s.session,
    source: s.source,
    status,
    modelTs: s.analysis.lastTs ?? 0,
    receivedMs: s.receivedMs,
    notice: DEMO_NOTICE,
  });
}
// Small shared table helpers; all exposed rows retain their generated typed schemas.
function put(tab: any, row: any) {
  if (tab.id.find(row.id)) tab.id.update(row);
  else tab.insert(row);
}
function clear(tab: any) {
  for (const r of [...tab.iter()]) tab.id.delete(r.id);
}
function log(ctx: Ctx, action: string, value: unknown) {
  ctx.db.audit.insert({
    id: 0n,
    atMs: ms(ctx),
    actor: ctx.sender.toHexString(),
    action,
    json: JSON.stringify(value),
  });
  const rows = [...ctx.db.audit.iter()];
  for (const r of rows.slice(0, Math.max(0, rows.length - 500)))
    ctx.db.audit.id.delete(r.id);
}
function requireText(v: unknown, name: string, max = 160): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new SenderError(`Invalid ${name}`);
}
function graph(ctx: Ctx, s: State) {
  clear(ctx.db.entity);
  clear(ctx.db.edge);
  const node = (
    id: string,
    kind: string,
    systemId: string,
    facilityId: string,
    lat: number,
    lon: number,
    data: unknown,
  ) =>
    ctx.db.entity.insert({
      id,
      kind,
      systemId,
      facilityId,
      label: id,
      lat,
      lon,
      json: JSON.stringify(data),
      simulated: true,
    });
  const link = (a: string, b: string, relation: string) =>
    ctx.db.edge.insert({
      id: JSON.stringify([a, b, relation]),
      fromId: a,
      toId: b,
      relation,
    });
  for (const system of s.network.systems) {
    const d = system.disposal_site;
    node(system.id, "system", system.id, "", d.lat, d.lon, {});
    node(d.id, "disposal", system.id, "", d.lat, d.lon, d);
    for (const f of system.facilities) {
      node(f.id, "facility", system.id, f.id, f.lat, f.lon, {});
      link(system.id, f.id, "contains");
      for (const [kind, a] of [
        ["tank", f.tank],
        ["pump", f.pump],
        ["pipeline", f.pipeline],
      ] as const) {
        node(a.id, kind, system.id, f.id, f.lat, f.lon, a);
        link(f.id, a.id, "contains");
      }
      for (const w of f.wells) {
        node(w.id, "well", system.id, f.id, f.lat, f.lon, w);
        link(w.id, f.tank.id, "produces_water_into");
      }
      link(f.tank.id, f.pump.id, "feeds");
      link(f.pump.id, f.pipeline.id, "pumps_into");
      link(f.pipeline.id, d.id, "delivers_to");
    }
  }
  node("DEMO_C101", "compressor", "DEMO", "", 0, 0, { capacityMcfd: 9000 });
  node("DEMO_S101", "scrubber", "DEMO", "", 0, 0, {
    warningPct: s.network.defaults.tank_limits_pct.warning,
    shutdownPct: s.network.defaults.tank_limits_pct.shutdown,
  });
  link("DEMO_S101", "DEMO_C101", "demo_protective_trip");
  SIX_WELLS.forEach((rate, i) => {
    node(`DEMO_WELL_${i + 1}`, "gas_well", "DEMO", "", 0, 0, {
      nominalMcfd: rate,
    });
    link(`DEMO_WELL_${i + 1}`, "DEMO_C101", "depends_on");
  });
  if (s.mode !== "replay") {
    node("UNO_R4", "sensor_device", "DEMO", "", 0, 0, {
      measured: "water level / indicator switches",
      mappedTank: s.mapping,
    });
    link("UNO_R4", s.mapping, "demo_measurement_maps_to");
    link("UNO_R4", "DEMO_S101", "demo_measurement_maps_to");
  }
}
function currentDataset(s: State): Dataset {
  return {
    folder: s.source,
    network: s.network,
    ops: s.ops,
    readings: s.analysis.lastFrame,
    firstTs: s.analysis.lastTs ?? 0,
    nowTs: s.analysis.lastTs ?? 0,
    latest: new Map(),
  };
}
function snapshots(ctx: Ctx, s: State, quality = "ready") {
  const analysis = summarizeAnalysis(s.analysis, s);
  clear(ctx.db.event);
  for (const e of analysis.events)
    ctx.db.event.insert({
      id: e.id,
      facilityId: e.facilityId,
      assetId: e.assetId,
      category: e.category,
      status: e.status,
      onsetTs: e.onsetTs,
      json: JSON.stringify(e),
    });
  const acknowledged = new Set(
    [...ctx.db.alert.iter()].filter((a) => a.acknowledged).map((a) => a.id),
  );
  clear(ctx.db.alert);
  const addAlert = (
    id: string,
    assetId: string,
    severity: string,
    message: string,
    data: unknown,
  ) =>
    ctx.db.alert.insert({
      id,
      assetId,
      severity,
      message,
      acknowledged: acknowledged.has(id),
      json: JSON.stringify(data),
    });
  for (const e of analysis.alerts)
    addAlert(
      e.id,
      e.assetId,
      e.category === "pump_failure" ? "critical" : "warning",
      e.evidence.join(" "),
      e,
    );
  for (const f of s.network.systems.flatMap((x) => x.facilities)) {
    const level = s.analysis.lastFrame.find(
      (r) => r.asset_id === f.tank.id && r.metric === "level_pct",
    )?.value;
    if (
      level !== undefined &&
      level >= s.network.defaults.tank_limits_pct.warning
    )
      addAlert(
        `${f.tank.id}/level`,
        f.tank.id,
        level >= s.network.defaults.tank_limits_pct.shutdown
          ? "critical"
          : "warning",
        `Fictional tank level ${level.toFixed(2)}%; threshold ${s.network.defaults.tank_limits_pct.shutdown}%.`,
        { levelPct: level, simulated: true },
      );
  }
  if (quality !== "ready")
    addAlert(
      "telemetry-quality",
      s.mapping,
      "warning",
      `Telemetry ${quality}; recommendations and countdown withheld.`,
      { quality },
    );
  if (s.compressorTripped)
    addAlert(
      "DEMO_C101/trip",
      "DEMO_C101",
      "critical",
      "Latched fictional compressor trip; six demo wells deferred. No physical output.",
      { simulated: true },
    );
  clear(ctx.db.prediction);
  for (const p of analysis.predictions)
    ctx.db.prediction.insert({
      id: p.facilityId,
      state: quality === "ready" ? p.state : quality,
      hoursToShutdown:
        quality === "ready" ? (p.hoursToShutdown ?? undefined) : undefined,
      json: JSON.stringify(
        quality === "ready"
          ? p
          : { ...p, state: quality, hoursToShutdown: null },
      ),
    });
  clear(ctx.db.recommendation);
  let report: PlanningReport = {
    nowTs: analysis.nowTs,
    systems: [],
    advisoryOnly: true,
    basis: "Data unavailable",
  };
  if (quality === "ready" && s.analysis.lastTs !== null) {
    report = planDataset(currentDataset(s), analysis, {
      horizonHours: (s.fieldPolicy ?? DEFAULT_FIELD_POLICY).horizonHours,
      maxSearchStates: 2000,
      maxLinearVertices: 100000,
    });
    for (const p of report.systems)
      ctx.db.recommendation.insert({
        id: p.systemId,
        status: p.status,
        totalCost: p.status === "unavailable" ? undefined : p.result.totalCost,
        savings: p.status === "unavailable" ? undefined : p.result.savings,
        revision: s.revision,
        json: JSON.stringify({
          ...p,
          basis: report.basis,
          nowTs: report.nowTs,
        }),
        advisoryOnly: true,
      });
  }
  clear(ctx.db.mlInference);
  if (s.model && quality === "ready") {
    for (const sys of s.network.systems)
      for (const f of sys.facilities) {
        const x = contextFeatures(
          s.mlContext ?? createMLContext(),
          f.id,
          s.model.features.length,
        );
        const out = x
          ? infer(s.model, x, s.analysis.lastTs ?? 0)
          : {
              state: "not_observable",
              label: null,
              scores: null,
              reason: "Pump is off/faulted or current features are incomplete.",
            };
        ctx.db.mlInference.insert({
          id: f.id,
          state: out.state,
          label: out.label ?? undefined,
          json: JSON.stringify({
            ...out,
            features: x,
            provenance:
              s.mode === "replay"
                ? s.source.startsWith("Synthetic counterfactual:")
                  ? "synthetic_counterfactual_demo"
                  : "synthetic_challenge_data"
                : "fictional_field_flows",
            notice:
              "Advisory class scores, not a physical failure probability. Temperature scaling uses synthetic validation data.",
          }),
        });
      }
  }
  clear(ctx.db.warningForecast);
  for (const p of warningForecasts(
    s.tankContext ?? createTankContext(),
    s.network,
    s.analysis.lastFrame,
    analysis.nowTs,
    quality,
  ))
    ctx.db.warningForecast.insert({
      id: p.id,
      facilityId: p.facilityId,
      state: p.state,
      hoursToShutdown: p.hoursToShutdown ?? undefined,
      json: JSON.stringify(p),
    });
  updateField(
    ctx,
    s,
    analysis,
    report,
    quality,
    acknowledged.has("FIELD/shutdown"),
  );
  compressor(ctx, s);
}
function updateField(
  ctx: Ctx,
  s: State,
  analysis: ReturnType<typeof summarizeAnalysis>,
  report: PlanningReport,
  quality: string,
  acknowledged: boolean,
) {
  const policy = (s.fieldPolicy ??= { ...DEFAULT_FIELD_POLICY });
  const decision = evaluateField(
    currentDataset(s),
    analysis,
    report,
    policy,
    quality,
    warningForecasts(
      s.tankContext ?? createTankContext(),
      s.network,
      s.analysis.lastFrame,
      analysis.nowTs,
      quality,
    ),
  );
  if (decision.trigger && !s.fieldTrip) {
    s.fieldTrip = {
      reason: decision.triggerReason!,
      atTs: analysis.nowTs,
      atMs: ms(ctx),
      decision,
    };
    log(ctx, "automatic_simulated_field_shutdown", {
      ...s.fieldTrip,
      revision: s.revision,
      notice: DEMO_NOTICE,
    });
  }
  const tripped = !!s.fieldTrip;
  put(ctx.db.fieldControl, {
    id: "FIELD",
    state: tripped ? "shut_down" : decision.state,
    tripped,
    reason: s.fieldTrip?.reason ?? decision.explanation,
    revision: s.revision,
    json: JSON.stringify({
      policy,
      decision,
      latched: s.fieldTrip ?? null,
      notice: DEMO_NOTICE,
    }),
  });
  if (tripped) {
    put(ctx.db.alert, {
      id: "FIELD/shutdown",
      assetId: "FIELD",
      severity: "critical",
      message: `Complete simulated field shutdown: ${s.fieldTrip!.reason}. All modeled production is off; sensors remain monitored.`,
      acknowledged,
      json: JSON.stringify(s.fieldTrip),
    });
    for (const row of ctx.db.recommendation.iter())
      ctx.db.recommendation.id.update({
        ...row,
        status: "field_shutdown",
        totalCost: undefined,
        savings: undefined,
        json: JSON.stringify({
          ...JSON.parse(row.json),
          overriddenBy: "latched_simulated_field_shutdown",
        }),
      });
  }
  const frame = new Map(
    s.analysis.lastFrame.map((r) => [`${r.asset_id}/${r.metric}`, r.value]),
  );
  clear(ctx.db.wellProduction);
  for (const sys of s.network.systems)
    for (const f of sys.facilities)
      for (const w of f.wells) {
        const observed = frame.get(`${w.id}/status`),
          known = quality === "ready" && observed !== undefined,
          effective = tripped ? false : known ? observed === 1 : null;
        ctx.db.wellProduction.insert({
          id: w.id,
          systemId: sys.id,
          facilityId: f.id,
          state: tripped
            ? "field_shutdown"
            : !known
              ? "unknown"
              : effective
                ? "producing"
                : "observed_shut_in",
          deliveredOilBpd:
            effective === null ? undefined : effective ? w.oil_bpd : 0,
          deliveredGasMcfd:
            effective === null ? undefined : effective ? w.gas_mcfd : 0,
          deliveredWaterBpd:
            effective === null
              ? undefined
              : effective
                ? w.baseline_water_bpd
                : 0,
          json: JSON.stringify({
            observedStatus: observed ?? null,
            quality,
            nominalOilBpd: w.oil_bpd,
            nominalGasMcfd: w.gas_mcfd,
            nominalWaterBpd: w.baseline_water_bpd,
            deferredOilBpd:
              effective === null ? null : effective ? 0 : w.oil_bpd,
            deferredGasMcfd:
              effective === null ? null : effective ? 0 : w.gas_mcfd,
            basis:
              "Configured baseline rates; effective software-only simulation state. Recorded sensor readings are unchanged.",
            simulated: true,
          }),
        });
      }
  clear(ctx.db.assetOperation);
  for (const e of ctx.db.entity.iter()) {
    const monitoring = ["tank", "sensor_device", "scrubber"].includes(e.kind),
      observed = frame.get(`${e.id}/status`);
    const status = monitoring
      ? "monitoring"
      : tripped
        ? "field_shutdown"
        : quality !== "ready"
          ? "unknown"
          : observed === 2
            ? "fault"
            : observed === 0
              ? "stopped"
              : observed === 1
                ? "running"
                : "observed";
    ctx.db.assetOperation.insert({
      id: e.id,
      state: status,
      json: JSON.stringify({
        observedStatus: observed ?? null,
        fieldShutdown: tripped,
        simulated: true,
      }),
    });
  }
}
function compressor(ctx: Ctx, s: State) {
  const tripped = s.compressorTripped || !!s.fieldTrip;
  const rate = SIX_WELLS.reduce((a, b) => a + b, 0);
  const actions = compressorComparison(s.compressor, tripped);
  const best = actions
    .filter((a) => a.feasible)
    .sort((a, b) => a.totalCost - b.totalCost)[0];
  put(ctx.db.compressorState, {
    id: "DEMO_C101",
    tripped: tripped,
    deferredMcfd: tripped ? rate : 0,
    json: JSON.stringify({
      wells: SIX_WELLS.map((nominalMcfd, i) => ({
        id: `DEMO_WELL_${i + 1}`,
        nominalMcfd,
        deliveredMcfd: tripped ? 0 : nominalMcfd,
        deferredMcfd: tripped ? nominalMcfd : 0,
      })),
      config: s.compressor,
      recommendation: {
        state: tripped ? "advisory" : "monitoring",
        action: tripped ? best.action : null,
        totalCost: tripped ? best.totalCost : null,
        reason: best.reason,
        advisoryOnly: true,
      },
      notice: DEMO_NOTICE,
    }),
  });
  clear(ctx.db.compressorAction);
  for (const a of actions)
    ctx.db.compressorAction.insert({
      id: a.action,
      feasible: a.feasible,
      totalCost: a.totalCost,
      json: JSON.stringify({
        ...a,
        basis: tripped ? "simulated_trip" : "no_trip",
        notice: DEMO_NOTICE,
      }),
    });
}
function validateRows(s: State, rows: Reading[]) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw new SenderError("Frame needs 1..1000 readings");
  const assets = validateConfiguration(s.network, s.ops),
    seen = new Set<string>();
  for (const r of rows) {
    const a = assets.get(r.asset_id),
      key = JSON.stringify([r.asset_id, r.metric]);
    if (
      !a ||
      !a.metrics.includes(r.metric) ||
      seen.has(key) ||
      !Number.isSafeInteger(r.ts_unix) ||
      r.ts_unix < 0 ||
      Date.parse(r.timestamp) !== r.ts_unix * 1000 ||
      !Number.isFinite(r.value) ||
      r.value < 0 ||
      (r.metric === "level_pct" && r.value > 100) ||
      (r.metric === "status" &&
        !(a.kind === "pump" ? [0, 1, 2] : [0, 1]).includes(r.value))
    )
      throw new SenderError("Invalid, unknown or duplicate telemetry");
    seen.add(key);
  }
}
function publishReadings(ctx: Ctx, s: State) {
  clear(ctx.db.sensorCurrent);
  for (const r of s.analysis.lastFrame) {
    const provenance =
      s.mode === "replay"
        ? s.source.startsWith("Synthetic counterfactual:")
          ? "synthetic_counterfactual_demo"
          : "synthetic_challenge_data"
        : r.metric === "level_pct" && r.asset_id === s.mapping
          ? s.mode === "hardware"
            ? "measured_mapped_to_fictional_tank"
            : "mock_level"
          : "fictional_field_simulation";
    const row = {
      assetId: r.asset_id,
      metric: r.metric,
      value: r.value,
      observedTs: r.ts_unix,
      receivedMs: s.receivedMs,
      provenance,
    };
    ctx.db.sensorCurrent.insert({
      id: JSON.stringify([r.asset_id, r.metric]),
      ...row,
    });
    ctx.db.sensorReading.insert({ id: 0n, ...row });
  }
  const history = [...ctx.db.sensorReading.iter()];
  for (const r of history.slice(0, Math.max(0, history.length - 3000)))
    ctx.db.sensorReading.id.delete(r.id);
}
export const init = db.init((ctx) => {
  ctx.db.writer.insert({ identity: ctx.sender, admin: true });
  ctx.db.tick.insert({ id: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
});
export const grant_writer = db.reducer(
  { identity: t.identity(), enabled: t.bool() },
  (ctx, { identity, enabled }) => {
    auth(ctx, true);
    const w = ctx.db.writer.identity.find(identity);
    if (w?.admin)
      throw new SenderError("Publisher administrator cannot be revoked");
    if (enabled) {
      if (!w) ctx.db.writer.insert({ identity, admin: false });
    } else ctx.db.writer.identity.delete(identity);
    log(ctx, "writer_authorization", {
      identity: identity.toHexString(),
      enabled,
    });
  },
);
export const configure_session = db.reducer(
  { json: t.string() },
  (ctx, { json }) => {
    auth(ctx);
    if (json.length > 200000) throw new SenderError("Configuration too large");
    const c = JSON.parse(json) as {
      network: Network;
      ops: Operations;
      mode: string;
      session: string;
      source: string;
      mapping?: string;
      virtualStep?: number;
      model?: Model;
      fieldPolicy?: FieldPolicy;
    };
    validateConfiguration(c.network, c.ops);
    requireText(c.session, "session");
    requireText(c.source, "source", 1024);
    if (
      c.network.systems.length > 10 ||
      c.network.systems.some(
        (sys) =>
          sys.facilities.length > 20 ||
          sys.facilities.some((f) => f.wells.length > 10),
      ) ||
      Object.values(c.ops.systems).some((v) => v.emergency_fleet_size > 6)
    )
      throw new SenderError(
        "Configuration exceeds prototype asset/fleet limits",
      );
    if (!["replay", "mock", "hardware"].includes(c.mode))
      throw new SenderError("Unknown source mode");
    const mapping = c.mapping ?? c.network.systems[0].facilities[0].tank.id;
    if (
      !c.network.systems.some((sys) =>
        sys.facilities.some((f) => f.tank.id === mapping),
      )
    )
      throw new SenderError("Unknown hardware mapping");
    const virtualStep = c.virtualStep ?? 300;
    if (!Number.isInteger(virtualStep) || virtualStep < 1 || virtualStep > 600)
      throw new SenderError("Virtual step must be 1..600 seconds");
    if (c.model) validateModel(c.model);
    if (c.fieldPolicy) validateFieldPolicy(c.fieldPolicy);
    const s: State = {
      network: c.network,
      ops: c.ops,
      analysis: createAnalysisState(c.network),
      mode: c.mode,
      session: c.session,
      source: c.source,
      loading: c.mode === "replay",
      revision: (ctx.db.appState.id.find("main")?.revision ?? 0) + 1,
      receivedMs: ms(ctx),
      mapping,
      sequence: -1,
      hardwareSamples: [],
      virtualStep,
      trip: false,
      model: c.model,
      compressor: { ...DEFAULT_COMPRESSOR },
      compressorTripped: false,
      mlContext: createMLContext(),
      tankContext: createTankContext(),
      fieldPolicy: c.fieldPolicy ?? { ...DEFAULT_FIELD_POLICY },
    };
    for (const tab of [
      ctx.db.sensorCurrent,
      ctx.db.sensorReading,
      ctx.db.event,
      ctx.db.alert,
      ctx.db.prediction,
      ctx.db.recommendation,
      ctx.db.mlInference,
      ctx.db.hardwareStatus,
      ctx.db.hardwarePrediction,
      ctx.db.scenario,
      ctx.db.modelInfo,
      ctx.db.fieldControl,
      ctx.db.wellProduction,
      ctx.db.assetOperation,
      ctx.db.warningForecast,
    ])
      clear(tab);
    if (s.model)
      ctx.db.modelInfo.insert({
        id: "anomaly",
        trainedThroughTs: s.model.trainedThroughTs,
        json: JSON.stringify({
          kind: s.model.kind,
          features: s.model.features,
          classes: s.model.classes,
          notice: "Synthetic practice training; uncalibrated advisory scores.",
        }),
      });
    graph(ctx, s);
    compressor(ctx, s);
    save(ctx, s, s.loading ? "loading" : "awaiting_data");
    log(ctx, "configure_session", {
      mode: s.mode,
      session: s.session,
      source: s.source,
    });
  },
);
export const ingest_frames = db.reducer(
  { session: t.string(), json: t.string() },
  (ctx, { session, json }) => {
    auth(ctx);
    const s = state(ctx);
    if (s.mode !== "replay" || session !== s.session)
      throw new SenderError("Source/session mismatch");
    if (json.length > 700000) throw new SenderError("Batch too large");
    const frames = JSON.parse(json) as Reading[][];
    if (
      !Array.isArray(frames) ||
      !frames.length ||
      frames.length > 20 ||
      (!s.loading && frames.length !== 1)
    )
      throw new SenderError("Use 1..20 import frames or one live replay frame");
    for (const rows of frames) {
      validateRows(s, rows);
      advanceFrame(s, rows);
    }
    s.receivedMs = ms(ctx);
    s.revision++;
    publishReadings(ctx, s);
    if (!s.loading) snapshots(ctx, s);
    save(ctx, s, s.loading ? "loading" : "ready");
  },
);
export const finish_import = db.reducer(
  { session: t.string() },
  (ctx, { session }) => {
    auth(ctx);
    const s = state(ctx);
    if (session !== s.session || !s.loading || s.analysis.lastTs === null)
      throw new SenderError("No matching import");
    s.loading = false;
    s.revision++;
    snapshots(ctx, s);
    save(ctx, s, "ready");
    log(ctx, "finish_import", { session, modelTs: s.analysis.lastTs });
  },
);
export const ingest_hardware = db.reducer(
  { json: t.string() },
  (ctx, { json }) => {
    auth(ctx);
    const s = state(ctx);
    if (s.mode === "replay")
      throw new SenderError("Switch to a hardware/mock session first");
    if (json.length > 2048) throw new SenderError("Packet too large");
    const p = JSON.parse(json) as {
      session: string;
      deviceId: string;
      sequence: number;
      observedAtMs: number;
      levelPct: number | null;
      wet: boolean;
      tilt: boolean;
      shock: boolean;
    };
    if (
      p.session !== s.session ||
      p.deviceId !== "UNO_R4" ||
      !Number.isInteger(p.sequence) ||
      p.sequence < 0 ||
      p.sequence > 4294967295 ||
      p.sequence <= s.sequence ||
      !Number.isFinite(p.observedAtMs) ||
      Math.abs(ms(ctx) - p.observedAtMs) > 10000 ||
      ["wet", "tilt", "shock"].some(
        (k) => typeof p[k as "wet"] !== "boolean",
      ) ||
      (p.levelPct !== null &&
        (typeof p.levelPct !== "number" ||
          !Number.isFinite(p.levelPct) ||
          p.levelPct < 0 ||
          p.levelPct > 100))
    )
      throw new SenderError(
        "Invalid, old, duplicate, or mismatched hardware packet",
      );
    if (s.sequence >= 0 && ms(ctx) - s.receivedMs < 100)
      throw new SenderError("Maximum hardware rate is 10 Hz");
    const previous = ctx.db.hardwareStatus.id.find("UNO_R4");
    if (previous && p.observedAtMs <= JSON.parse(previous.json).observedAtMs)
      throw new SenderError("Hardware timestamps must increase");
    s.sequence = p.sequence;
    s.receivedMs = ms(ctx);
    s.revision++;
    const quality = p.levelPct === null ? "invalid" : "ready";
    put(ctx.db.hardwareStatus, {
      id: "UNO_R4",
      quality,
      levelPct: p.levelPct ?? undefined,
      sequence: p.sequence,
      receivedMs: s.receivedMs,
      json: JSON.stringify({
        ...p,
        provenance: s.mode,
        notice: "Switch indicators are not calibrated health diagnostics.",
      }),
    });
    if (p.levelPct === null) s.hardwareSamples = [];
    else {
      if (
        s.hardwareSamples.at(-1) &&
        p.observedAtMs - s.hardwareSamples.at(-1)!.atMs > 5000
      )
        s.hardwareSamples = [];
      if (
        s.hardwareSamples.at(-1) &&
        p.observedAtMs <= s.hardwareSamples.at(-1)!.atMs
      )
        throw new SenderError("Hardware timestamps must increase");
      s.hardwareSamples.push({ atMs: p.observedAtMs, levelPct: p.levelPct });
      s.hardwareSamples = s.hardwareSamples.filter(
        (x) => p.observedAtMs - x.atMs <= 30000,
      );
    }
    const hp =
      p.levelPct === null
        ? { state: "invalid", secondsToThreshold: null }
        : predictLevel(
            s.hardwareSamples,
            ms(ctx),
            s.network.defaults.tank_limits_pct.shutdown,
          );
    put(ctx.db.hardwarePrediction, {
      id: "UNO_R4",
      state: hp.state,
      secondsToThreshold: hp.secondsToThreshold ?? undefined,
      json: JSON.stringify({
        ...hp,
        units: "seconds of tabletop sensor time",
        thresholdPct: s.network.defaults.tank_limits_pct.shutdown,
      }),
    });
    if (p.levelPct !== null) {
      s.trip ||= p.levelPct >= s.network.defaults.tank_limits_pct.shutdown;
      s.compressorTripped ||= s.trip;
      const ts =
          (s.analysis.lastTs ?? Math.floor(ms(ctx) / 1000) - s.virtualStep) +
          s.virtualStep,
        rows: Reading[] = [];
      const add = (asset_id: string, metric: string, value: number) =>
        rows.push({
          timestamp: new Date(ts * 1000).toISOString(),
          ts_unix: ts,
          asset_id,
          metric,
          value,
        });
      for (const sys of s.network.systems)
        for (const f of sys.facilities) {
          const selected = f.tank.id === s.mapping,
            flow = selected ? 0 : f.pump.max_flow_bpd;
          let inflow = 0;
          for (const w of f.wells) {
            const producing = !(selected && s.trip);
            add(w.id, "status", producing ? 1 : 0);
            add(w.id, "water_bpd", producing ? w.baseline_water_bpd : 0);
            if (producing) inflow += w.baseline_water_bpd;
          }
          add(f.id, "inflow_bpd", inflow);
          add(f.tank.id, "level_pct", selected ? p.levelPct : 50);
          add(f.pump.id, "status", selected ? 2 : 1);
          add(f.pump.id, "flow_bpd", flow);
          add(
            f.pump.id,
            "discharge_psi",
            selected ? 0 : sys.disposal_site.pressure_psi + 150,
          );
          add(f.pipeline.id, "receive_flow_bpd", flow);
          add(
            f.pipeline.id,
            "pressure_psi",
            selected ? 0 : sys.disposal_site.pressure_psi + 50,
          );
        }
      advanceFrame(s, rows);
      publishReadings(ctx, s);
    }
    snapshots(ctx, s, quality);
    for (const name of ["wet", "tilt", "shock"] as const)
      if (p[name])
        put(ctx.db.alert, {
          id: `UNO_R4/${name}`,
          assetId: "UNO_R4",
          severity: "warning",
          message: `${name} indicator active (${s.mode}); not a calibrated fault diagnosis.`,
          acknowledged: false,
          json: "{}",
        });
    save(ctx, s, quality);
  },
);
export const acknowledge_alert = db.reducer(
  { id: t.string() },
  (ctx, { id }) => {
    auth(ctx);
    const a = ctx.db.alert.id.find(id);
    if (!a) throw new SenderError("Unknown active alert");
    ctx.db.alert.id.update({ ...a, acknowledged: true });
    log(ctx, "acknowledge_alert", { id });
  },
);
export const simulate_compressor = db.reducer(
  { tripped: t.bool(), configJson: t.string() },
  (ctx, { tripped, configJson }) => {
    auth(ctx);
    const s = state(ctx);
    if (configJson.length > 2000)
      throw new SenderError("Compressor settings too large");
    const config = JSON.parse(configJson) as CompressorConfig;
    compressorComparison(config, tripped);
    s.compressor = config;
    s.compressorTripped = s.trip || tripped;
    s.revision++;
    const quality =
      s.mode !== "replay" && ms(ctx) - s.receivedMs > 10000
        ? "stale"
        : ctx.db.appState.id.find("main")!.status;
    snapshots(ctx, s, quality);
    save(ctx, s, quality);
    log(ctx, "simulate_compressor", { tripped: s.compressorTripped, config });
  },
);
export const compare_scenario = db.reducer(
  { id: t.string(), json: t.string() },
  (ctx, { id, json }) => {
    auth(ctx);
    requireText(id, "scenario id", 80);
    const s = state(ctx);
    if (
      s.loading ||
      ctx.db.appState.id.find("main")?.status !== "ready" ||
      (s.mode !== "replay" && ms(ctx) - s.receivedMs > 10000)
    )
      throw new SenderError("Fresh ready data required");
    if (json.length > 2000) throw new SenderError("Scenario too large");
    const changes = JSON.parse(json) as {
      oilPrice?: number;
      gasPrice?: number;
      repairHours?: number;
      fleetSize?: number;
    };
    if (
      Object.keys(changes).some(
        (k) =>
          !["oilPrice", "gasPrice", "repairHours", "fleetSize"].includes(k),
      )
    )
      throw new SenderError("Unknown scenario field");
    for (const n of Object.values(changes))
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100000)
        throw new SenderError("Invalid scenario value");
    if (
      changes.repairHours !== undefined &&
      (changes.repairHours <= 0 || changes.repairHours > 168)
    )
      throw new SenderError("Repair horizon must be >0 and <=168 hours");
    if (
      changes.fleetSize !== undefined &&
      (!Number.isInteger(changes.fleetSize) || changes.fleetSize > 6)
    )
      throw new SenderError("Demo fleet must be 0..6");
    const copy = JSON.parse(JSON.stringify(s)) as State;
    if (changes.oilPrice !== undefined)
      copy.ops.prices.oil_per_bbl = changes.oilPrice;
    if (changes.gasPrice !== undefined)
      copy.ops.prices.gas_per_mcf = changes.gasPrice;
    if (changes.repairHours !== undefined)
      copy.ops.expected_repair_hours.pump_failure = changes.repairHours;
    if (changes.fleetSize !== undefined)
      for (const v of Object.values(copy.ops.systems))
        v.emergency_fleet_size = changes.fleetSize;
    const result = planDataset(
      currentDataset(copy),
      summarizeAnalysis(copy.analysis, copy),
      {
        maxSearchStates: 2000,
        maxLinearVertices: 100000,
        horizonHours: (copy.fieldPolicy ?? DEFAULT_FIELD_POLICY).horizonHours,
      },
    );
    if (
      !ctx.db.scenario.id.find(id) &&
      [...ctx.db.scenario.iter()].length >= 20
    )
      throw new SenderError("Maximum 20 scenarios per session");
    put(ctx.db.scenario, {
      id,
      baseRevision: s.revision,
      json: JSON.stringify({ changes, result, advisoryOnly: true }),
    });
    log(ctx, "compare_scenario", { id, changes, baseRevision: s.revision });
  },
);
export const record_decision = db.reducer(
  { systemId: t.string(), revision: t.u32(), note: t.string() },
  (ctx, { systemId, revision, note }) => {
    auth(ctx);
    requireText(note, "note", 1000);
    const s = state(ctx),
      r = ctx.db.recommendation.id.find(systemId);
    if (
      !r ||
      r.status !== "planned" ||
      r.revision !== revision ||
      s.revision !== revision ||
      ctx.db.appState.id.find("main")?.status !== "ready" ||
      (s.mode !== "replay" && ms(ctx) - s.receivedMs > 10000)
    )
      throw new SenderError("Choose a current ready plan revision");
    log(ctx, "advisory_decision", {
      systemId,
      revision,
      note,
      plan: JSON.parse(r.json),
      notice: DEMO_NOTICE,
    });
  },
);
export const set_field_policy = db.reducer(
  { json: t.string() },
  (ctx, { json }) => {
    auth(ctx);
    if (json.length > 2000) throw new SenderError("Policy too large");
    const s = state(ctx),
      policy = JSON.parse(json) as FieldPolicy;
    if (Object.keys(policy).some((k) => !(k in DEFAULT_FIELD_POLICY)))
      throw new SenderError("Unknown field policy key");
    validateFieldPolicy(policy);
    s.fieldPolicy = policy;
    s.revision++;
    const quality =
      s.mode !== "replay" && ms(ctx) - s.receivedMs > 10000
        ? "stale"
        : ctx.db.appState.id.find("main")!.status;
    snapshots(ctx, s, quality);
    save(ctx, s, quality);
    log(ctx, "set_field_policy", { policy, notice: DEMO_NOTICE });
  },
);
export const reset_field = db.reducer(
  { revision: t.u32(), reason: t.string() },
  (ctx, { revision, reason }) => {
    auth(ctx);
    requireText(reason, "reset reason", 1000);
    const s = state(ctx);
    if (!s.fieldTrip) throw new SenderError("Field is not latched shut");
    if (
      s.revision !== revision ||
      ctx.db.appState.id.find("main")!.status !== "ready" ||
      (s.mode !== "replay" && ms(ctx) - s.receivedMs > 10000)
    )
      throw new SenderError(
        "Fresh current revision required for simulated restart",
      );
    s.fieldTrip = undefined;
    s.revision++;
    snapshots(ctx, s);
    if (s.fieldTrip)
      throw new SenderError(
        "Shutdown condition is still active; simulated restart rejected",
      );
    save(ctx, s, "ready");
    log(ctx, "reset_simulated_field", {
      reason,
      revision,
      notice: DEMO_NOTICE,
    });
  },
);
export const housekeeping = db.reducer(
  { onSchedule: tick },
  { arg: tick.rowType },
  (ctx) => {
    if (!ctx.sender.isEqual(ctx.identity))
      throw new SenderError("Scheduled calls only");
    const row = ctx.db.runtime.id.find("main");
    if (!row) return;
    const s = state(ctx);
    if (
      s.mode === "replay" ||
      ms(ctx) - s.receivedMs <= 10000 ||
      ctx.db.appState.id.find("main")?.status === "stale"
    )
      return;
    s.revision++;
    s.hardwareSamples = [];
    const h = ctx.db.hardwareStatus.id.find("UNO_R4");
    if (h) ctx.db.hardwareStatus.id.update({ ...h, quality: "stale" });
    put(ctx.db.hardwarePrediction, {
      id: "UNO_R4",
      state: "stale",
      secondsToThreshold: undefined,
      json: JSON.stringify({ state: "stale", secondsToThreshold: null }),
    });
    snapshots(ctx, s, "stale");
    save(ctx, s, "stale");
  },
);
