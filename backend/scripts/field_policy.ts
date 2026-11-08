import { connectNode } from "./connection.js";
const args = process.argv.slice(2),
  conn = await connectNode(true);
try {
  const row = conn.db.fieldControl.id.find("FIELD");
  if (!row) throw new Error("Start the backend first");
  if (args.includes("--reset"))
    await conn.reducers.resetField({
      revision: conn.db.appState.id.find("main")!.revision,
      reason: "Operator requested simulated restart after reviewing conditions",
    });
  else {
    const policy = JSON.parse(row.json).policy;
    for (const [flag, key] of [
      ["--hours", "horizonHours"],
      ["--opex", "avoidableOperatingCostPerHour"],
      ["--shutdown-cost", "shutdownCost"],
      ["--restart-cost", "restartCost"],
    ]) {
      const i = args.indexOf(flag);
      if (i >= 0) policy[key] = Number(args[i + 1]);
    }
    await conn.reducers.setFieldPolicy({ json: JSON.stringify(policy) });
  }
  console.log(JSON.parse(conn.db.fieldControl.id.find("FIELD")!.json));
} finally {
  conn.disconnect();
}
