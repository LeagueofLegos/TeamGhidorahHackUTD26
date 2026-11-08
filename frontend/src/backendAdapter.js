export function readJson(row) {
  try {
    return JSON.parse(row?.json ?? "{}");
  } catch {
    return {};
  }
}
export function adaptSensors(view, connected = true) {
  if (!view?.state) return [];
  const ready = connected && view.state.status === "ready",
    values = new Map(
      view.sensors.map((r) => [`${r.assetId}/${r.metric}`, r.value]),
    );
  const facilities = view.entities.filter((e) => e.kind === "facility"),
    lats = facilities.map((f) => f.lat),
    lons = facilities.map((f) => f.lon),
    latMin = Math.min(...lats),
    latSpan = Math.max(...lats) - latMin || 1,
    lonMin = Math.min(...lons),
    lonSpan = Math.max(...lons) - lonMin || 1;
  const field = readJson(view.field),
    fieldOff = !!view.field?.tripped;
  return view.entities
    .filter((e) => e.kind === "tank")
    .map((e) => {
      const matching = view.alerts.filter(
          (a) =>
            a.assetId === e.id ||
            a.assetId ===
              view.entities.find(
                (p) => p.facilityId === e.facilityId && p.kind === "pump",
              )?.id ||
            a.assetId ===
              view.entities.find(
                (p) => p.facilityId === e.facilityId && p.kind === "pipeline",
              )?.id,
        ),
        level = values.get(`${e.id}/level_pct`),
        forecast =
          view.warningForecasts.find((p) => p.id === e.id) ??
          view.predictions.find((p) => p.id === e.facilityId),
        prediction = readJson(forecast),
        system = view.recommendations.find((r) => r.id === e.systemId),
        plan = readJson(system),
        facilityPlan = plan.result?.plans?.find(
          (p) => p.facilityId === e.facilityId,
        ),
        ml = readJson(view.ml.find((r) => r.id === e.facilityId));
      const device = view.entities.find(
          (p) => p.kind === "sensor_device" && readJson(p).mappedTank === e.id,
        ),
        physical = device
          ? view.hardwarePredictions.find((p) => p.id === device.id)
          : undefined;
      const eta = ready
        ? fieldOff
          ? 0
          : physical
            ? physical.secondsToThreshold
            : forecast?.hoursToShutdown !== undefined
              ? forecast.hoursToShutdown * 3600
              : null
        : null;
      const severe =
        fieldOff || matching.some((a) => a.severity === "critical");
      return {
        id: e.id,
        name: e.facilityId,
        kind: "Tank / pump train",
        backend: true,
        facilityId: e.facilityId,
        systemId: e.systemId,
        alertIds: matching.map((a) => a.id),
        value:
          ready && level !== undefined
            ? `${level.toFixed(2)}%`
            : `${level === undefined ? "—" : level.toFixed(2) + "%"} · ${connected ? view.state.status : "disconnected"}`,
        severityLevel: severe ? 3 : matching.length ? 2 : 1,
        x: 12 + ((e.lon - lonMin) / lonSpan) * 74,
        y: 14 + (1 - (e.lat - latMin) / latSpan) * 68,
        area: e.systemId,
        message: fieldOff
          ? "Complete simulated field shutdown is latched."
          : matching.map((a) => a.message).join(" ") ||
            "No active rule-based alert for this facility.",
        advice: fieldOff
          ? "All modeled production is off. Sensors continue to be monitored. Review the field decision and reset only after its condition clears."
          : facilityPlan
            ? `${facilityPlan.kind.replaceAll("_", " ")} — ${facilityPlan.explanation}`
            : matching.length
              ? "Inspect the recorded evidence; no priced response is supplied for this condition."
              : "Continue observing current readings.",
        operations: fieldOff
          ? "Entire simulated field"
          : `${e.facilityId} · ${view.wellProduction.filter((w) => w.facilityId === e.facilityId).length} wells`,
        timeToActSeconds: eta,
        etaBasis: physical
          ? "Tabletop sensor seconds"
          : "Field no-action estimate",
        etaState: ready
          ? fieldOff
            ? "field_shutdown"
            : (physical?.state ?? forecast?.state ?? "no_warning")
          : connected
            ? view.state.status
            : "disconnected",
        etaReason: prediction.reason ?? prediction.basis ?? "",
        costGrowthPerSecond: 0,
        startedAt: Date.now(),
        actions:
          ready && !fieldOff && system?.status === "planned"
            ? [
                {
                  name: `Record coordinated ${e.systemId} plan for review`,
                  baseCost: system.totalCost,
                  systemId: e.systemId,
                  revision: system.revision,
                },
              ]
            : [],
        acknowledged:
          matching.length > 0 && matching.every((a) => a.acknowledged),
        ml,
        fieldDecision: field.decision,
      };
    });
}
