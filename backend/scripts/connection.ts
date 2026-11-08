import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "../client/connect.js";
import { cli, database, httpOrigin, uri } from "./cli.js";
export async function connectNode(
  authorize = false,
  onDisconnect?: (error?: Error) => void,
) {
  const file = `.tokens/${createHash("sha256").update(`${uri}/${database}`).digest("hex").slice(0, 20)}.txt`;
  await mkdir(".tokens", { recursive: true });
  const token =
    process.env.SPACETIME_TOKEN ??
    (await readFile(file, "utf8").catch(() => undefined));
  let nextToken: string | undefined;
  const conn = await connect({
    uri,
    database,
    token,
    onToken: (t) => {
      nextToken = t;
    },
    onDisconnect,
  });
  if (nextToken) await writeFile(file, nextToken, { mode: 0o600 });
  if (authorize) {
    try {
      cli([
        "call",
        "--server",
        httpOrigin,
        database,
        "grant_writer",
        JSON.stringify(conn.identity!.toHexString()),
        "true",
      ]);
    } catch (error) {
      conn.disconnect();
      throw error;
    }
  }
  return conn;
}
