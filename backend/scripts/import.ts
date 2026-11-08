import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadDataset, type Reading } from "../src/dataset.js";
import { connectNode } from "./connection.js";
import type { DbConnection } from "../client/connect.js";
export const DEFAULT_FOLDER =
  "data/HackUTD-ZeroDay/history/snapshot_2026-10-08T1200";
export function frames(readings: Reading[]) {
  const result: Reading[][] = [];
  for (const r of readings) {
    if (result.at(-1)?.[0].ts_unix !== r.ts_unix) result.push([]);
    result.at(-1)!.push(r);
  }
  return result;
}
export async function configure(
  conn: DbConnection,
  folder: string,
  mode = "replay",
  mapping?: string,
  sourceLabel?: string,
) {
  const d = await loadDataset(folder),
    session = randomUUID(),
    model = JSON.parse(await readFile("models/anomaly.json", "utf8"));
  await conn.reducers.configureSession({
    json: JSON.stringify({
      network: d.network,
      ops: d.ops,
      mode,
      session,
      source:
        sourceLabel ?? (mode === "replay" ? d.folder : `${mode} tabletop demo`),
      mapping,
      model,
    }),
  });
  return { dataset: d, session };
}
export async function importDataset(conn: DbConnection, folder: string) {
  const { dataset, session } = await configure(conn, folder),
    all = frames(dataset.readings);
  for (let i = 0; i < all.length; i += 20) {
    await conn.reducers.ingestFrames({
      session,
      json: JSON.stringify(all.slice(i, i + 20)),
    });
    if (i % 200 === 0)
      console.log(
        `Import ${Math.min(i + 20, all.length)}/${all.length} frames`,
      );
  }
  await conn.reducers.finishImport({ session });
  console.log(
    `Ready: ${new Date(dataset.nowTs * 1000).toISOString()} (${all.length} frames)`,
  );
}
export async function replayDataset(
  conn: DbConnection,
  folder: string,
  intervalMs = 1000,
) {
  if (!Number.isFinite(intervalMs) || intervalMs < 100)
    throw new Error("Replay interval must be >=100 ms");
  const { dataset, session } = await configure(conn, folder),
    all = frames(dataset.readings);
  await conn.reducers.ingestFrames({ session, json: JSON.stringify([all[0]]) });
  await conn.reducers.finishImport({ session });
  for (const rows of all.slice(1)) {
    await delay(intervalMs);
    await conn.reducers.ingestFrames({ session, json: JSON.stringify([rows]) });
    console.log(rows[0].timestamp);
  }
}
if (process.argv[1]?.endsWith("import.ts")) {
  const conn = await connectNode(true);
  try {
    const folder = process.argv[2] ?? DEFAULT_FOLDER;
    if (process.argv.includes("--replay"))
      await replayDataset(
        conn,
        folder,
        Number(process.env.REPLAY_INTERVAL_MS ?? 1000),
      );
    else await importDataset(conn, folder);
  } finally {
    conn.disconnect();
  }
}
