import { connect, onSnapshot } from "../../backend/client/connect.ts";
let current = {
    connected: false,
    writer: false,
    view: null,
    error: "",
    identity: "",
    busy: false,
  },
  connection,
  cleanup,
  generation = 0,
  retryTimer;
const listeners = new Set();
export const getBackendState = () => current;
export const subscribeBackend = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function update(patch) {
  current = { ...current, ...patch };
  for (const listener of listeners) listener(current);
}
async function post(path, body) {
  const response = await fetch(`/api/demo/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Demo request failed");
  return result;
}
export async function startBackend(attempt = 0) {
  const gen = ++generation;
  let established = false;
  clearTimeout(retryTimer);
  cleanup?.();
  connection?.disconnect();
  update({ connected: false, writer: false, error: "" });
  const uri = import.meta.env.VITE_SPACETIME_URI ?? "ws://127.0.0.1:3000",
    database = import.meta.env.VITE_SPACETIME_DATABASE ?? "ghidorah-demo",
    key = `ghidorah:${uri}/${database}`;
  try {
    const conn = await connect({
      uri,
      database,
      token: localStorage.getItem(key) ?? undefined,
      onToken: (token) => localStorage.setItem(key, token),
      onDisconnect: () => {
        if (gen !== generation || !established) return;
        update({
          connected: false,
          writer: false,
          error:
            "Backend disconnected. Countdown and actions withheld; reconnecting.",
        });
        retryTimer = setTimeout(() => {
          void startBackend();
        }, 2000);
      },
    });
    if (gen !== generation) {
      conn.disconnect();
      return;
    }
    connection = conn;
    established = true;
    cleanup = onSnapshot(conn, (view) => {
      if (gen === generation) update({ view });
    });
    update({ connected: true, identity: conn.identity.toHexString() });
    try {
      await post("authorize", { identity: conn.identity.toHexString() });
      if (gen === generation && current.connected) update({ writer: true });
    } catch (error) {
      update({ error: `Read-only connection. ${error.message}` });
    }
  } catch (error) {
    if (gen !== generation) return;
    update({ connected: false, error: String(error.message ?? error) });
    if (attempt < 10)
      retryTimer = setTimeout(() => {
        void startBackend(attempt + 1);
      }, 2000);
  }
}
async function action(fn) {
  if (!current.connected || !current.writer)
    throw new Error("A connected, authorized local demo session is required");
  update({ busy: true });
  try {
    return await fn();
  } finally {
    update({ busy: false });
  }
}
export const backendActions = {
  reconnect: startBackend,
  source: (mode) => action(() => post("source", { mode })),
  acknowledge: (ids) =>
    action(async () => {
      for (const id of ids) await connection.reducers.acknowledgeAlert({ id });
    }),
  record: (systemId) =>
    action(() =>
      connection.reducers.recordDecision({
        systemId,
        revision: current.view.state.revision,
        note: "Operator reviewed the current coordinated system plan in the dashboard.",
      }),
    ),
  policy: (policy) =>
    action(() =>
      connection.reducers.setFieldPolicy({ json: JSON.stringify(policy) }),
    ),
  reset: () =>
    action(() =>
      connection.reducers.resetField({
        revision: current.view.state.revision,
        reason:
          "Operator reviewed cleared conditions and requested simulated field restart.",
      }),
    ),
};
