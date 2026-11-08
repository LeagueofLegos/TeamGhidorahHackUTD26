import { connectNode } from "./connection.js";
import { configure, DEFAULT_FOLDER } from "./import.js";
import { allAtRiskFrames } from "../src/demo_frames.js";
const conn = await connectNode(true);
try {
  const { session, dataset } = await configure(
    conn,
    DEFAULT_FOLDER,
    "replay",
    undefined,
    "Synthetic counterfactual: all facilities at risk",
  );
  await conn.reducers.ingestFrames({
    session,
    json: JSON.stringify(
      allAtRiskFrames(dataset.network, Math.floor(Date.now() / 1000)),
    ),
  });
  await conn.reducers.finishImport({ session });
  console.log(
    "All-at-risk synthetic demo loaded. Complete simulated field shutdown:",
    conn.db.fieldControl.id.find("FIELD")?.tripped,
  );
} finally {
  conn.disconnect();
}
