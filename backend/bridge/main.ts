import { setTimeout as delay } from "node:timers/promises";
import type { SerialPort } from "serialport";
import { connectNode } from "../scripts/connection.js";
import { configure, DEFAULT_FOLDER } from "../scripts/import.js";
import {
  LineFramer,
  mockReading,
  parseTelemetry,
  type Telemetry,
} from "./protocol.js";
const args = process.argv.slice(2),
  option = (key: string) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
if (args.includes("--list")) {
  const { SerialPort } = await import("serialport");
  console.table(await SerialPort.list());
  process.exit(0);
}
const mock = args.includes("--mock"),
  path = option("--port");
if (mock === !!path) throw new Error("Choose --mock or --port COM3");
const count = Number(option("--count") ?? 60);
if (!Number.isInteger(count) || count < 1 || count > 86400)
  throw new Error("Count must be 1..86400");
let stopped = false,
  port: SerialPort | undefined;
let conn: Awaited<ReturnType<typeof connectNode>> | undefined;
function stop() {
  if (stopped) return;
  stopped = true;
  if (port?.isOpen) port.close();
  conn?.disconnect();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const connection = await connectNode(true, () => {
    if (!stopped) {
      console.error(
        "Database disconnected. Restart the bridge; stale readings are not replayed.",
      );
      process.exitCode = 1;
      stop();
    }
  });
  conn = connection;
  const { session } = await configure(
    connection,
    option("--dataset") ?? DEFAULT_FOLDER,
    mock ? "mock" : "hardware",
    option("--tank"),
  );
  let sequence = 0;
  const send = async (p: Telemetry, at: number) => {
    await connection.reducers.ingestHardware({
      json: JSON.stringify({
        session,
        deviceId: p.device_id,
        sequence: sequence++,
        observedAtMs: at,
        levelPct: p.water_level_pct,
        wet: p.wet,
        tilt: p.tilt,
        shock: p.shock,
      }),
    });
    console.log(`Accepted ${sequence}: ${p.water_level_pct ?? "invalid"}%`);
  };
  console.log(
    "Receive-only demo bridge. No serial commands or equipment controls.",
  );
  if (mock) {
    for (let i = 0; i < count && !stopped; i++) {
      await send(mockReading(i), Date.now());
      if (i < count - 1) await delay(1000);
    }
    stop();
  } else {
    const { SerialPort } = await import("serialport");
    // Opening USB serial can reset some boards. No write(), GPIO, relay, or actuator API exists here.
    port = new SerialPort({ path: path!, baudRate: 115200, autoOpen: false });
    let busy = false,
      lastAt = 0;
    const framer = new LineFramer((line) => {
      let p: Telemetry;
      try {
        p = parseTelemetry(line);
      } catch (error) {
        console.error("Ignored invalid frame:", String(error));
        return;
      }
      const at = Date.now();
      if (busy || at - lastAt < 100 || stopped) return;
      busy = true;
      lastAt = at;
      void send(p, at)
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
          stop();
        })
        .finally(() => {
          busy = false;
        });
    }, console.error);
    port.on("data", (chunk) => framer.push(chunk.toString("utf8")));
    port.on("error", (error) => {
      console.error(error);
      process.exitCode = 1;
      stop();
    });
    port.on("close", stop);
    port.open((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
        stop();
      } else console.log(`Listening on ${path}, 115200 baud`);
    });
  }
} catch (error) {
  stop();
  throw error;
}
