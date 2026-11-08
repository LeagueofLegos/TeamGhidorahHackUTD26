import { DbConnection } from "./module_bindings/index.js";
export { DbConnection } from "./module_bindings/index.js";
export const SUMMARY_TABLES = [
  "app_state",
  "entity",
  "edge",
  "sensor_current",
  "event",
  "alert",
  "prediction",
  "recommendation",
  "hardware_status",
  "hardware_prediction",
  "ml_inference",
  "model_info",
  "scenario",
  "audit",
  "compressor_state",
  "compressor_action",
] as const;
export type ConnectOptions = {
  uri?: string;
  database?: string;
  token?: string;
  onToken?: (token: string) => void;
  onDisconnect?: (error?: Error) => void;
  history?: boolean;
};
export function connect(options: ConnectOptions = {}) {
  return new Promise<DbConnection>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        conn.disconnect();
        reject(new Error("Database connection/subscription timed out"));
      }
    }, 20000);
    const conn = DbConnection.builder()
      .withUri(options.uri ?? "ws://127.0.0.1:3000")
      .withDatabaseName(options.database ?? "ghidorah-demo")
      .withToken(options.token)
      .onConnect((connection, _identity, token) => {
        options.onToken?.(token);
        connection
          .subscriptionBuilder()
          .onApplied(() => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve(connection);
            }
          })
          .onError((ctx) => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              connection.disconnect();
              reject(ctx.event);
            }
          })
          .subscribe(
            [
              ...SUMMARY_TABLES,
              ...(options.history ? ["sensor_reading"] : []),
            ].map((name) => `SELECT * FROM ${name}`),
          );
      })
      .onConnectError((_ctx, error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(error);
        }
      })
      .onDisconnect((_ctx, error) => {
        options.onDisconnect?.(error);
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(error ?? new Error("Disconnected before subscription"));
        }
      })
      .build();
  });
}
export function snapshot(conn: DbConnection) {
  return {
    state: conn.db.appState.id.find("main"),
    entities: [...conn.db.entity.iter()],
    edges: [...conn.db.edge.iter()],
    sensors: [...conn.db.sensorCurrent.iter()],
    events: [...conn.db.event.iter()],
    alerts: [...conn.db.alert.iter()],
    predictions: [...conn.db.prediction.iter()],
    recommendations: [...conn.db.recommendation.iter()],
    hardware: [...conn.db.hardwareStatus.iter()],
    hardwarePredictions: [...conn.db.hardwarePrediction.iter()],
    ml: [...conn.db.mlInference.iter()],
    scenarios: [...conn.db.scenario.iter()],
    compressor: [...conn.db.compressorState.iter()],
    compressorActions: [...conn.db.compressorAction.iter()],
  };
}
// React: call onSnapshot from a useEffect, and return its cleanup function.
// Coalesce row changes so the callback reads the complete applied cache update.
export function onSnapshot(
  conn: DbConnection,
  callback: (value: ReturnType<typeof snapshot>) => void,
) {
  let queued = false,
    disposed = false;
  const changed = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) callback(snapshot(conn));
    });
  };
  const tables = Object.values(conn.db);
  for (const table of tables) {
    table.onInsert(changed);
    table.onUpdate(changed);
    table.onDelete(changed);
  }
  changed();
  return () => {
    disposed = true;
    for (const table of tables) {
      table.removeOnInsert(changed);
      table.removeOnUpdate(changed);
      table.removeOnDelete(changed);
    }
  };
}
