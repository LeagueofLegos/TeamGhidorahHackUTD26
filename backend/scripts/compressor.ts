import { connectNode } from "./connection.js";
const args = process.argv.slice(2),
  conn = await connectNode(true);
try {
  const row = conn.db.compressorState.id.find("DEMO_C101");
  if (!row) throw new Error("Start the backend first");
  const config = JSON.parse(row.json).config;
  const index = args.indexOf("--hours");
  if (index >= 0) config.horizonHours = Number(args[index + 1]);
  if (args.includes("--no-standby")) config.standbyAvailable = false;
  if (args.includes("--no-maintenance")) config.maintenanceAvailable = false;
  await conn.reducers.simulateCompressor({
    tripped: !args.includes("--reset"),
    configJson: JSON.stringify(config),
  });
  console.table(
    [...conn.db.compressorAction.iter()].map((a) => ({
      action: a.id,
      feasible: a.feasible,
      totalCost: a.totalCost,
    })),
  );
  console.log(
    JSON.parse(conn.db.compressorState.id.find("DEMO_C101")!.json)
      .recommendation,
  );
} finally {
  conn.disconnect();
}
