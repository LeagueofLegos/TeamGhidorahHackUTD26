import { validateConfiguration, requireNumber } from "./configuration.js";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse } from "csv-parse/sync";

export type Well = {
  id: string;
  baseline_water_bpd: number;
  oil_bpd: number;
  gas_mcfd: number;
};

export type Facility = {
  id: string;
  lat: number;
  lon: number;
  wells: Well[];
  tank: {
    id: string;
    capacity_bbl: number;
  };
  pump: {
    id: string;
    max_flow_bpd: number;
    start_level_pct: number;
    stop_level_pct: number;
  };
  pipeline: {
    id: string;
    max_bpd: number;
    max_pressure_psi: number;
  };
};

export type Network = {
  defaults: {
    tank_limits_pct: {
      warning: number;
      shutdown: number;
    };
  };
  systems: {
    id: string;
    disposal_site: {
      id: string;
      lat: number;
      lon: number;
      pressure_psi: number;
    };
    facilities: Facility[];
  }[];
};

export type Operations = {
  prices: {
    oil_per_bbl: number;
    gas_per_mcf: number;
  };
  expected_repair_hours: {
    pump_failure: number;
  };
  emergency_trucking: {
    truck_capacity_bbl: number;
    cost_per_trip: number;
  };
  systems: Record<
    string,
    {
      emergency_fleet_size: number;
      facilities: Record<
        string,
        {
          response_min: number;
          cycle_min: number;
        }
      >;
    }
  >;
};

type RawReading = {
  timestamp: string;
  ts_unix: string;
  asset_id: string;
  metric: string;
  value: string;
};

export type Reading = Omit<RawReading, "ts_unix" | "value"> & {
  ts_unix: number;
  value: number;
};

export type Dataset = {
  folder: string;
  network: Network;
  ops: Operations;
  readings: Reading[];
  firstTs: number;
  nowTs: number;
  latest: Map<string, Reading>;
};

const key = (assetId: string, metric: string) =>
  JSON.stringify([assetId, metric]);

export async function loadDataset(folder: string): Promise<Dataset> {
  const directory = resolve(folder);

  // Answer keys belong in separate evaluation tools.
  const [networkText, opsText, csvText] = await Promise.all([
    readFile(join(directory, "network.json"), "utf8"),
    readFile(join(directory, "ops.json"), "utf8"),
    readFile(join(directory, "telemetry.csv"), "utf8"),
  ]);

  const network = JSON.parse(networkText) as Network;
  const ops = JSON.parse(opsText) as Operations;

  const assets = validateConfiguration(network, ops);

  const raw = parse<RawReading>(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });

  if (raw.length === 0) {
    throw new Error("telemetry.csv contains no readings.");
  }

  const readings: Reading[] = raw.map((row, index) => {
    const line = index + 2;

    const fields = [
      row.timestamp,
      row.ts_unix,
      row.asset_id,
      row.metric,
      row.value,
    ];

    if (fields.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`Missing CSV field near line ${line}`);
    }

    const ts = Number(row.ts_unix);
    const value = Number(row.value);

    if (
      !Number.isSafeInteger(ts) ||
      ts < 0 ||
      Date.parse(row.timestamp) !== ts * 1000
    ) {
      throw new Error(`Invalid or inconsistent timestamp near line ${line}`);
    }

    requireNumber(value, `sensor value near line ${line}`);

    const asset = assets.get(row.asset_id);

    if (!asset || !asset.metrics.includes(row.metric)) {
      throw new Error(
        `Unknown asset/metric near line ${line}: ` +
          `${row.asset_id}/${row.metric}`,
      );
    }

    if (row.metric === "level_pct" && value > 100) {
      throw new Error(`Tank percentage exceeds 100 near line ${line}`);
    }

    if (
      row.metric === "status" &&
      !(asset.kind === "pump" ? [0, 1, 2] : [0, 1]).includes(value)
    ) {
      throw new Error(`Invalid status near line ${line}`);
    }

    return {
      ...row,
      ts_unix: ts,
      value,
    };
  });

  readings.sort(
    (a, b) =>
      a.ts_unix - b.ts_unix ||
      a.asset_id.localeCompare(b.asset_id) ||
      a.metric.localeCompare(b.metric),
  );

  const latest = new Map<string, Reading>();

  for (const reading of readings) {
    const series = key(reading.asset_id, reading.metric);

    if (latest.get(series)?.ts_unix === reading.ts_unix) {
      throw new Error(
        `Duplicate reading: ${reading.asset_id}/` +
          `${reading.metric} at ${reading.timestamp}`,
      );
    }

    latest.set(series, reading);
  }

  return {
    folder: directory,
    network,
    ops,
    readings,
    latest,
    firstTs: readings[0].ts_unix,
    nowTs: readings[readings.length - 1].ts_unix,
  };
}

// Return measurements from the current dataset frame only.
// An older reading must not silently appear to be current.
export function currentValue(
  dataset: Dataset,
  assetId: string,
  metric: string,
): number | null {
  const reading = dataset.latest.get(key(assetId, metric));

  return reading?.ts_unix === dataset.nowTs ? reading.value : null;
}
