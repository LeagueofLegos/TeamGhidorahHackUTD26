import type { Network, Operations } from "./dataset.js";
export function requireNumber(
  value: unknown,
  label: string,
  strictlyPositive = false,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (strictlyPositive ? value <= 0 : value < 0)
  ) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

export function validateConfiguration(network: Network, ops: Operations) {
  if (
    !network?.defaults?.tank_limits_pct ||
    !Array.isArray(network.systems) ||
    network.systems.length === 0 ||
    !ops?.prices ||
    !ops.systems ||
    !ops.expected_repair_hours ||
    !ops.emergency_trucking
  ) {
    throw new Error("network.json or ops.json has an invalid structure.");
  }

  const limits = network.defaults.tank_limits_pct;

  requireNumber(limits.warning, "warning percentage", true);
  requireNumber(limits.shutdown, "shutdown percentage", true);

  if (limits.warning >= limits.shutdown || limits.shutdown > 100) {
    throw new Error("Require 0 < warning < shutdown <= 100.");
  }

  requireNumber(ops.prices.oil_per_bbl, "oil price");
  requireNumber(ops.prices.gas_per_mcf, "gas price");

  requireNumber(ops.expected_repair_hours.pump_failure, "repair hours", true);

  requireNumber(
    ops.emergency_trucking.truck_capacity_bbl,
    "truck capacity",
    true,
  );

  requireNumber(ops.emergency_trucking.cost_per_trip, "truck cost");

  const assets = new Map<string, { kind: string; metrics: string[] }>();

  const ids = new Set<string>();

  const register = (id: string, kind: string, metrics: string[]) => {
    if (typeof id !== "string" || !id.trim() || ids.has(id)) {
      throw new Error(`Missing or duplicate ID: ${String(id)}`);
    }

    ids.add(id);
    assets.set(id, { kind, metrics });
  };

  for (const system of network.systems) {
    register(system.id, "system", []);
    register(system.disposal_site.id, "disposal", []);

    const systemOps = ops.systems[system.id];

    if (!systemOps || !Array.isArray(system.facilities)) {
      throw new Error(`Missing facilities or operations for ${system.id}`);
    }

    requireNumber(systemOps.emergency_fleet_size, `${system.id} fleet size`);

    if (!Number.isInteger(systemOps.emergency_fleet_size)) {
      throw new Error("Fleet size must be an integer.");
    }

    for (const facility of system.facilities) {
      if (
        !facility.tank ||
        !facility.pump ||
        !facility.pipeline ||
        !Array.isArray(facility.wells) ||
        facility.wells.length === 0
      ) {
        throw new Error(`Incomplete facility: ${facility.id}`);
      }

      register(facility.id, "facility", ["inflow_bpd"]);

      register(facility.tank.id, "tank", ["level_pct"]);

      register(facility.pump.id, "pump", [
        "status",
        "flow_bpd",
        "discharge_psi",
      ]);

      register(facility.pipeline.id, "pipeline", [
        "receive_flow_bpd",
        "pressure_psi",
      ]);

      requireNumber(
        facility.tank.capacity_bbl,
        `${facility.id} tank capacity`,
        true,
      );

      requireNumber(
        facility.pump.max_flow_bpd,
        `${facility.id} pump capacity`,
        true,
      );

      const travel = systemOps.facilities?.[facility.id];

      if (!travel) {
        throw new Error(`Missing truck travel times for ${facility.id}`);
      }

      requireNumber(travel.response_min, `${facility.id} response time`);

      requireNumber(travel.cycle_min, `${facility.id} cycle time`, true);

      for (const well of facility.wells) {
        register(well.id, "well", ["water_bpd", "status"]);

        requireNumber(well.baseline_water_bpd, `${well.id} baseline water`);

        requireNumber(well.oil_bpd, `${well.id} oil production`);
        requireNumber(well.gas_mcfd, `${well.id} gas production`);
      }
    }
  }

  return assets;
}
