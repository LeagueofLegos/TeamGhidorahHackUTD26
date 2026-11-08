import { execFile, spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const backend = fileURLToPath(new URL("../backend", import.meta.url));
function run(script, args = []) {
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", script, ...args],
      { cwd: backend, windowsHide: true, timeout: 120000, maxBuffer: 2e6 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error((stderr || stdout || error.message).slice(-1800)))
          : resolve(stdout),
    ),
  );
}
export function demoApi() {
  let producer,
    busy = false;
  function stopProducer() {
    if (producer?.pid && producer.exitCode === null) {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/PID", String(producer.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {}
      } else producer.kill();
    }
    producer = undefined;
  }
  return {
    name: "ghidorah-local-demo-api",
    configureServer(server) {
      server.httpServer?.once("close", stopProducer);
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/demo/")) return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const host = req.headers.host ?? "",
          origin = req.headers.origin,
          remote = req.socket.remoteAddress;
        if (
          req.method !== "POST" ||
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ||
          !/^((127\.0\.0\.1)|(localhost)):\d+$/.test(host) ||
          origin !== `http://${host}`
        ) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Local same-origin POST required" }));
          return;
        }
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024) throw new Error("Request too large");
          }
          const input = JSON.parse(body);
          if (req.url === "/api/demo/authorize") {
            if (!/^[0-9a-f]{64}$/i.test(input.identity ?? ""))
              throw new Error("Invalid identity");
            await run("scripts/authorize_browser.ts", [input.identity]);
            res.end(JSON.stringify({ writer: true }));
            return;
          }
          if (
            req.url !== "/api/demo/source" ||
            !["snapshot", "mock", "all_at_risk", "stop_mock"].includes(
              input.mode,
            )
          )
            throw new Error("Unknown demo action");
          if (busy) {
            res.statusCode = 409;
            res.end(
              JSON.stringify({ error: "Another source change is running" }),
            );
            return;
          }
          busy = true;
          try {
            stopProducer();
            if (input.mode === "mock") {
              producer = spawn(
                process.execPath,
                [
                  "node_modules/tsx/dist/cli.mjs",
                  "bridge/main.ts",
                  "--mock",
                  "--count",
                  "86400",
                ],
                { cwd: backend, windowsHide: true, stdio: "ignore" },
              );
              producer.on("error", () => {
                producer = undefined;
              });
            } else if (input.mode === "snapshot")
              await run("scripts/import.ts");
            else if (input.mode === "all_at_risk")
              await run("scripts/field_demo.ts");
            res.end(JSON.stringify({ accepted: true, mode: input.mode }));
          } finally {
            busy = false;
          }
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(error.message ?? error) }));
        }
      });
    },
  };
}
