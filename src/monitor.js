const REQUIRED_FILES = ["network.json", "ops.json", "telemetry.csv"];
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 2_000_000;
const METRICS_BY_ASSET = {
  facility: new Set(["inflow_bpd"]),
  well: new Set(["water_bpd", "status"]),
  tank: new Set(["level_pct", "overflow"]),
  pump: new Set(["status", "flow_bpd", "discharge_psi"]),
  pipeline: new Set(["receive_flow_bpd", "pressure_psi"]),
};

function assertNumber(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
    if (rows.length > MAX_ROWS) throw new Error("Telemetry file exceeds the supported row limit.");
  }
  if (quoted) throw new Error("Telemetry CSV contains an unterminated quoted field.");
  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

export function createDatasetContext(network, ops) {
  const limits = network?.defaults?.tank_limits_pct;
  if (!Array.isArray(network?.systems) || network.systems.length === 0 || !limits) {
    throw new Error("network.json must define systems and tank limits.");
  }
  assertNumber(limits.warning, "Tank warning limit", { min: 0.1, max: 100 });
  assertNumber(limits.shutdown, "Tank shutdown limit", { min: 0.1, max: 100 });
  if (limits.warning >= limits.shutdown) {
    throw new Error("Tank warning must be lower than its shutdown limit.");
  }
  if (!ops?.systems || !ops?.expected_repair_hours || !ops?.emergency_trucking || !ops?.prices) {
    throw new Error("ops.json is missing prices, repair time, or trucking configuration.");
  }
  assertNumber(ops.prices.oil_per_bbl, "Oil price", { max: 1_000_000 });
  assertNumber(ops.prices.gas_per_mcf, "Gas price", { max: 1_000_000 });
  assertNumber(ops.expected_repair_hours.pump_failure, "Pump repair time", { min: 0.01, max: 100_000 });
  assertNumber(ops.emergency_trucking.truck_capacity_bbl, "Truck capacity", { min: 0.01, max: 1_000_000 });
  assertNumber(ops.emergency_trucking.cost_per_trip, "Truck trip cost", { max: 1_000_000_000 });

  const assets = new Map();
  const addAsset = (id, type) => {
    if (typeof id !== "string" || !id.trim() || assets.has(id)) {
      throw new Error(`Network contains a missing or duplicate asset ID: ${String(id)}.`);
    }
    assets.set(id, type);
  };
  for (const system of network.systems) {
    addAsset(system.id, "system");
    addAsset(system.disposal_site?.id, "disposal");
    assertNumber(system.disposal_site?.pressure_psi, `${system.id} disposal pressure`, { max: 100_000 });
    if (!Array.isArray(system.facilities)) throw new Error(`${system.id} is missing facilities.`);
    for (const facility of system.facilities) {
      addAsset(facility.id, "facility");
      addAsset(facility.tank?.id, "tank");
      addAsset(facility.pump?.id, "pump");
      addAsset(facility.pipeline?.id, "pipeline");
      if (!Array.isArray(facility.wells) || !facility.wells.length) {
        throw new Error(`${facility.id} must define at least one well.`);
      }
      assertNumber(facility.tank.capacity_bbl, `${facility.id} tank capacity`, { min: 0.01 });
      assertNumber(facility.pump.max_flow_bpd, `${facility.id} pump capacity`, { min: 0.01 });
      for (const well of facility.wells) {
        addAsset(well.id, "well");
        assertNumber(well.oil_bpd, `${well.id} oil production`, { max: 1_000_000 });
        assertNumber(well.gas_mcfd, `${well.id} gas production`, { max: 1_000_000 });
      }
      if (!ops.systems[system.id]?.facilities?.[facility.id]) {
        throw new Error(`ops.json is missing travel times for ${facility.id}.`);
      }
    }
    assertNumber(ops.systems[system.id]?.emergency_fleet_size, `${system.id} truck fleet`);
  }
  return { network, ops, assets };
}

export async function readDatasetFiles(fileList) {
  const files = [...fileList];
  const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
  if (byName.size !== files.length) throw new Error("Select only one copy of each data file.");
  const missing = REQUIRED_FILES.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`Select all three data files: ${missing.join(", ")}.`);
  for (const name of REQUIRED_FILES) {
    if (byName.get(name).size > MAX_FILE_BYTES) {
      throw new Error(`${name} exceeds the 100 MB file-size limit.`);
    }
  }

  const [network, ops, csvText] = await Promise.all([
    byName.get("network.json").text().then((text) => JSON.parse(text)),
    byName.get("ops.json").text().then((text) => JSON.parse(text)),
    byName.get("telemetry.csv").text(),
  ]);
  const { assets } = createDatasetContext(network, ops);
  const csvRows = parseCsv(csvText.replace(/^\uFEFF/, ""));
  const header = csvRows.shift()?.map((cell) => cell.trim());
  const expectedHeader = ["timestamp", "ts_unix", "asset_id", "metric", "value"];
  if (!header || expectedHeader.some((name) => !header.includes(name))) {
    throw new Error("telemetry.csv must include timestamp, ts_unix, asset_id, metric, and value columns.");
  }
  const columns = Object.fromEntries(expectedHeader.map((name) => [name, header.indexOf(name)]));
  const readings = csvRows.map((cells, index) => {
    const line = index + 2;
    const timestamp = cells[columns.timestamp]?.trim();
    const timestampSeconds = Number(cells[columns.ts_unix]);
    const assetId = cells[columns.asset_id]?.trim();
    const metric = cells[columns.metric]?.trim();
    const rawValue = cells[columns.value]?.trim();
    const value = Number(rawValue);
    const assetType = assets.get(assetId);
    if (
      !timestamp
      || !Number.isSafeInteger(timestampSeconds)
      || Date.parse(timestamp) !== timestampSeconds * 1000
      || !assetType
      || !METRICS_BY_ASSET[assetType]?.has(metric)
      || !rawValue
      || !Number.isFinite(value)
      || value < 0
    ) {
      throw new Error(`Invalid telemetry record on CSV line ${line}.`);
    }
    if (metric === "level_pct" && (value < 0 || value > 100)) {
      throw new Error(`Tank level on CSV line ${line} must be between 0 and 100%.`);
    }
    if (metric === "status" && ![0, 1, 2].includes(value)) {
      throw new Error(`Status on CSV line ${line} must be 0, 1, or 2.`);
    }
    if (metric === "overflow" && ![0, 1].includes(value)) {
      throw new Error(`Overflow signal on CSV line ${line} must be 0 or 1.`);
    }
    return { timestamp, ts_unix: timestampSeconds, asset_id: assetId, metric, value };
  });
  if (!readings.length) throw new Error("telemetry.csv contains no sensor readings.");
  readings.sort((a, b) => a.ts_unix - b.ts_unix);
  return {
    network,
    ops,
    assets,
    readings,
    nowTs: readings[readings.length - 1].ts_unix,
  };
}

function latestFor(readingsByAssetMetric, assetId, metric, ts) {
  const readings = readingsByAssetMetric.get(`${assetId}:${metric}`) || [];
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (reading.ts_unix < ts - 15 * 60) break;
    if (reading.ts_unix <= ts) return reading.value;
  }
  return null;
}

function inspectFacility({ system, facility, network, ops, frame, history, observedAt }) {
  const pumpStatus = latestFor(frame, facility.pump.id, "status", observedAt);
  const flow = latestFor(frame, facility.pump.id, "flow_bpd", observedAt);
  const tankLevel = latestFor(frame, facility.tank.id, "level_pct", observedAt);
  const overflow = latestFor(frame, facility.tank.id, "overflow", observedAt);
  const pipelinePressure = latestFor(frame, facility.pipeline.id, "pressure_psi", observedAt);
  const pumpPressure = latestFor(frame, facility.pump.id, "discharge_psi", observedAt);
  const alerts = [];
  const add = (category, severity, title, description, assetId, reading) => alerts.push({
    id: `${assetId}:${category}`,
    assetId,
    facilityId: facility.id,
    facilityName: facility.name || facility.id.replaceAll("_", " "),
    systemId: system.id,
    category,
    severity,
    title,
    description,
    reading,
    observedAt,
    evidence: [],
    status: "active",
  });

  if (overflow === 1) {
    add("tank_overflow", "alarm", "Overflow detected",
      "The tank overflow sensor is active. Follow the site emergency and shutdown procedures.",
      facility.tank.id, "Overflow signal active");
  } else if (tankLevel !== null) {
    const limits = network.defaults.tank_limits_pct;
    if (tankLevel >= limits.shutdown) {
      add("tank_shutdown", "alarm", "Tank at shutdown limit",
        `Tank level has reached ${tankLevel.toFixed(1)}%; wells should be shut in at ${limits.shutdown}%.`,
        facility.tank.id, `${tankLevel.toFixed(1)}%`);
    } else if (tankLevel >= limits.warning) {
      add("tank_warning", "warning", "Tank level rising",
        `Tank level is ${tankLevel.toFixed(1)}%, above the ${limits.warning}% warning point.`,
        facility.tank.id, `${tankLevel.toFixed(1)}%`);
    }
  }

  if (pumpStatus === 2) {
    add("pump_failure", "alarm", "Pump fault",
      "The pump reports a fault. Verify the tank level and follow the facility response procedure.",
      facility.pump.id, "Fault");
  }

  if (pumpStatus === 1 && pipelinePressure !== null && flow !== null && flow > 0) {
    const expectedPressure = system.disposal_site.pressure_psi + 50;
    const pressureDrop = expectedPressure - pipelinePressure;
    const leakSignal = (history.get(`${facility.pipeline.id}:pressure_psi`) || [])
      .filter((reading) => reading.ts_unix <= observedAt
        && reading.ts_unix >= observedAt - 10 * 60)
      .filter((reading) => reading.value < expectedPressure - 12);
    if (pressureDrop >= 12 && leakSignal.length >= 2) {
      add("pipeline_leak", "alarm", "Pipeline pressure loss",
        `Pipeline pressure is ${pressureDrop.toFixed(0)} psi below its expected operating offset while the pump is running. Arrange a field inspection.`,
        facility.pipeline.id, `${pipelinePressure.toFixed(1)} psi`);
    }
  }

  if (pumpStatus === 1 && pumpPressure !== null) {
    const expectedPressure = system.disposal_site.pressure_psi + 150;
    const pressureHistory = (history.get(`${facility.pump.id}:discharge_psi`) || [])
      .filter((reading) => reading.ts_unix <= observedAt
        && reading.ts_unix >= observedAt - 30 * 60)
      .slice(-6);
    const lowPressure = pressureHistory.filter((reading) => reading.value < expectedPressure - 8);
    if (pumpPressure < expectedPressure - 8 && lowPressure.length >= 3) {
      add("pump_degradation", "warning", "Pump output below normal",
        `Pump discharge pressure is below the documented operating offset. Arrange a field inspection.`,
        facility.pump.id, `${pumpPressure.toFixed(1)} psi`);
    }
  }

  const revenuePerHour = facility.wells.reduce(
    (sum, well) => sum + well.oil_bpd * ops.prices.oil_per_bbl
      + well.gas_mcfd * ops.prices.gas_per_mcf,
    0
  ) / 24;
  for (const alert of alerts) {
    alert.costGrowthPerSecond = alert.category === "pump_failure" || alert.category === "tank_shutdown"
      ? revenuePerHour / 3600
      : 0;
  }
  return alerts;
}

export function detectAlerts(dataset) {
  const readings = dataset.readings;
  const latestTs = dataset.nowTs;
  const byAssetMetric = new Map();
  for (const reading of readings) {
    const key = `${reading.asset_id}:${reading.metric}`;
    if (!byAssetMetric.has(key)) byAssetMetric.set(key, []);
    byAssetMetric.get(key).push(reading);
  }
  const result = dataset.network.systems.flatMap((system) => system.facilities.flatMap((facility) => (
    inspectFacility({
      system,
      facility,
      network: dataset.network,
      ops: dataset.ops,
      frame: byAssetMetric,
      history: byAssetMetric,
      observedAt: latestTs,
    })
  )));
  return result.sort((a, b) => (
    (a.severity === "alarm" ? 0 : 1) - (b.severity === "alarm" ? 0 : 1)
    || a.title.localeCompare(b.title)
  ));
}

export function evaluateSerialReading(dataset, reading, history) {
  validateSerialReading(dataset, reading);
  const system = dataset.network.systems.find((candidate) => (
    candidate.facilities.some((facility) => (
      facility.id === reading.asset_id
      || facility.tank.id === reading.asset_id
      || facility.pump.id === reading.asset_id
      || facility.pipeline.id === reading.asset_id
      || facility.wells.some((well) => well.id === reading.asset_id)
    ))
  ));
  const facility = system?.facilities.find((candidate) => (
    candidate.id === reading.asset_id
    || candidate.tank.id === reading.asset_id
    || candidate.pump.id === reading.asset_id
    || candidate.pipeline.id === reading.asset_id
    || candidate.wells.some((well) => well.id === reading.asset_id)
  ));
  if (!system || !facility) return [];
  const recent = new Map();
  for (const item of [...history, reading]) {
    const key = `${item.asset_id}:${item.metric}`;
    if (!recent.has(key)) recent.set(key, []);
    recent.get(key).push(item);
  }
  return inspectFacility({
    system,
    facility,
    network: dataset.network,
    ops: dataset.ops,
    frame: recent,
    history: recent,
    observedAt: reading.ts_unix,
  });
}

export function validateSerialReading(dataset, reading) {
  if (
    !reading
    || typeof reading.asset_id !== "string"
    || !dataset.assets.has(reading.asset_id)
    || !METRICS_BY_ASSET[dataset.assets.get(reading.asset_id)]?.has(reading.metric)
    || typeof reading.value !== "number"
    || !Number.isFinite(reading.value)
    || !Number.isSafeInteger(reading.ts_unix)
    || reading.ts_unix < 0
  ) {
    throw new Error("Sensor message must contain a known asset_id, supported metric, finite value, and integer ts_unix.");
  }
  if (reading.metric === "level_pct" && (reading.value < 0 || reading.value > 100)) {
    throw new Error("Tank level must be between 0 and 100%.");
  }
  if (reading.metric === "status" && ![0, 1, 2].includes(reading.value)) {
    throw new Error("Sensor status must be 0, 1, or 2.");
  }
  if (reading.metric === "overflow" && ![0, 1].includes(reading.value)) {
    throw new Error("Overflow signal must be 0 or 1.");
  }
}

export function parseSerialMessage(line) {
  if (typeof line !== "string" || line.length > 64 * 1024) {
    throw new Error("Sensor message is empty or exceeds 64 KB.");
  }
  const payload = JSON.parse(line);
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("Sensor message must be a JSON object.");
  }
  if (typeof payload.value !== "number" || !Number.isFinite(payload.value)) {
    throw new Error("Sensor message value must be a finite JSON number.");
  }
  if (!Number.isSafeInteger(payload.ts_unix) || payload.ts_unix < 0) {
    throw new Error("Sensor message ts_unix must be a non-negative integer.");
  }
  if (
    payload.timestamp !== undefined
    && (typeof payload.timestamp !== "string"
      || Date.parse(payload.timestamp) !== payload.ts_unix * 1000)
  ) {
    throw new Error("Sensor message timestamp must match ts_unix.");
  }
  return {
    timestamp: payload.timestamp,
    ts_unix: payload.ts_unix,
    asset_id: payload.asset_id,
    metric: payload.metric,
    value: payload.value,
  };
}
