import { connectNode } from "./connection.js";
import { onSnapshot } from "../client/connect.js";
const conn = await connectNode(false, () => {
  console.error(
    "Backend disconnected. Cached observations are no longer live. Restart watch after reconnecting.",
  );
  process.exitCode = 1;
});
const rounded = (n: number | undefined | null) =>
  n === undefined || n === null ? null : Number(n.toFixed(2));
let last = "";
onSnapshot(conn, (s) => {
  const digest = JSON.stringify(s, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (digest === last) return;
  last = digest;
  console.log(
    `\n${s.state?.mode ?? "unconfigured"} / ${s.state?.status ?? "awaiting configuration"} / revision ${s.state?.revision ?? 0}`,
  );
  if (s.alerts.length)
    console.table(
      s.alerts.map((a) => ({
        asset: a.assetId,
        severity: a.severity,
        acknowledged: a.acknowledged,
        message: a.message,
      })),
    );
  console.table(
    s.recommendations.map((r) => ({
      system: r.id,
      status: r.status,
      cost: rounded(r.totalCost),
      savings: rounded(r.savings),
    })),
  );
  if (s.predictions.length)
    console.table(
      s.predictions.map((p) => ({
        facility: p.id,
        state: p.state,
        minutesToShutdown:
          p.hoursToShutdown === undefined
            ? null
            : rounded(p.hoursToShutdown * 60),
      })),
    );
  if (s.warningForecasts.length) {
    console.log("WARNING → SHUTDOWN (field no-action forecast)");
    console.table(
      s.warningForecasts.map((p) => ({
        tank: p.id,
        state: p.state,
        minutesToShutdown:
          p.hoursToShutdown === undefined
            ? null
            : rounded(p.hoursToShutdown * 60),
      })),
    );
  }
  if (s.hardwarePredictions.length)
    console.table(
      s.hardwarePredictions.map((p) => ({
        device: p.id,
        state: p.state,
        levelPct: s.hardware.find((h) => h.id === p.id)?.levelPct,
        secondsToShutdown: rounded(p.secondsToThreshold),
      })),
    );
  if (s.field) {
    const f = JSON.parse(s.field.json),
      d = f.decision;
    console.table([
      {
        field: s.field.state,
        reason: s.field.reason,
        wellsOff: s.wellProduction.filter(
          (w) => w.deliveredOilBpd === 0 && w.deliveredGasMcfd === 0,
        ).length,
        totalWells: s.wellProduction.length,
        selectiveCost:
          d?.state === "ready" ? rounded(d?.selective.totalCost) : null,
        fullStopCost:
          d?.state === "ready" ? rounded(d?.fullShutdown.totalCost) : null,
      },
    ]);
  }
  if (s.ml.length) {
    console.log("ML advisory evidence (class score, not failure probability)");
    console.table(
      s.ml
        .filter((m) => m.label !== "normal")
        .map((m) => {
          const data = JSON.parse(m.json);
          return {
            facility: m.id,
            state: m.state,
            label: m.label ?? "withheld",
            score: rounded(data.topScore),
            evidence:
              data.evidence
                ?.map((e: { feature: string }) => e.feature)
                .join(", ") ?? data.reason,
          };
        }),
    );
  }
});
process.once("SIGINT", () => conn.disconnect());
