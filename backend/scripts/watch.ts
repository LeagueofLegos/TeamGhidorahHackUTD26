import { connectNode } from "./connection.js";
import { onSnapshot } from "../client/connect.js";
const conn = await connectNode();
let revision = -1;
onSnapshot(conn, (s) => {
  if (s.state?.revision === revision) return;
  revision = s.state?.revision ?? -1;
  console.log(
    `\n${s.state?.mode ?? "unconfigured"} / ${s.state?.status ?? "awaiting configuration"} / revision ${revision}`,
  );
  console.table(
    s.alerts.map((a) => ({
      asset: a.assetId,
      severity: a.severity,
      message: a.message,
    })),
  );
  console.table(
    s.recommendations.map((r) => ({
      system: r.id,
      status: r.status,
      cost: r.totalCost,
      savings: r.savings,
    })),
  );
  console.table(
    s.hardwarePredictions.map((p) => ({
      device: p.id,
      state: p.state,
      secondsToThreshold: p.secondsToThreshold,
    })),
  );
});
process.once("SIGINT", () => conn.disconnect());
