import { DbConnection, tables } from "./module_bindings";

const serverUri = import.meta.env.VITE_SPACETIMEDB_URI || "wss://maincloud.spacetimedb.com";
const databaseName = import.meta.env.VITE_SPACETIMEDB_DB_NAME || "thirsty-volcano-3675";
const tokenStorageKey = `${serverUri}/${databaseName}/auth_token`;
const pendingSnapshots = new Map();
const lastQueuedSnapshots = new Map();
const persistedSnapshots = new Map();
let activeConnection = null;
let activeSubscription = null;
let activeCallbacks = null;
let connected = false;
let syncing = false;
let reconnectFlushRequested = false;
let flushTimer = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function snapshotFingerprint(snapshot) {
  return JSON.stringify(snapshot, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  ));
}

function notifyStatus(status, message = "") {
  activeCallbacks?.onStatus(status, message);
}

async function flushSnapshots() {
  if (!connected || syncing || !activeConnection) return;
  syncing = true;
  try {
    while (connected && pendingSnapshots.size > 0) {
      const [feed, snapshot] = pendingSnapshots.entries().next().value;
      const fingerprint = snapshotFingerprint(snapshot);
      pendingSnapshots.delete(feed);
      if (fingerprint === persistedSnapshots.get(feed)) continue;
      try {
        await activeConnection.reducers.syncFeed(snapshot);
        persistedSnapshots.set(feed, fingerprint);
        notifyStatus("connected");
      } catch (error) {
        if (!pendingSnapshots.has(feed)) pendingSnapshots.set(feed, snapshot);
        console.error(`Could not save the ${feed} feed to SpacetimeDB.`, error);
        notifyStatus("error", `Could not save feed: ${errorMessage(error)}`);
        break;
      }
    }
  } finally {
    syncing = false;
    if (reconnectFlushRequested) {
      reconnectFlushRequested = false;
      if (connected) void flushSnapshots();
    }
  }
}

function scheduleFlush() {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    void flushSnapshots();
  }, 200);
}

export function persistFeedSnapshot(feed, snapshot) {
  const fingerprint = snapshotFingerprint(snapshot);
  if (
    fingerprint === lastQueuedSnapshots.get(feed)
    || fingerprint === persistedSnapshots.get(feed)
  ) return;
  lastQueuedSnapshots.set(feed, fingerprint);
  pendingSnapshots.set(feed, snapshot);
  scheduleFlush();
}

export function connectSpacetime({ onSnapshots, onStatus }) {
  activeCallbacks = { onSnapshots, onStatus };
  notifyStatus("connecting");
  const token = window.localStorage.getItem(tokenStorageKey);
  const builder = DbConnection.builder()
    .withUri(serverUri)
    .withDatabaseName(databaseName)
    .withToken(token || undefined)
    .withAutomaticReconnect()
    .onConnect((_connection, _identity, authToken) => {
      window.localStorage.setItem(tokenStorageKey, authToken);
      connected = true;
      notifyStatus("syncing");
    })
    .onDisconnect((_ctx, error, nextAttempt, delayMs) => {
      connected = false;
      if (error) console.warn("SpacetimeDB connection closed.", error);
      notifyStatus(
        nextAttempt === undefined ? "disconnected" : "reconnecting",
        error ? `${errorMessage(error)}${delayMs ? ` Retrying in ${delayMs} ms.` : ""}` : ""
      );
    })
    .onConnectError((_ctx, error, nextAttempt, delayMs) => {
      connected = false;
      console.error("Could not connect to SpacetimeDB.", error);
      notifyStatus(
        nextAttempt === undefined ? "error" : "reconnecting",
        `${errorMessage(error)}${delayMs ? ` Retrying in ${delayMs} ms.` : ""}`
      );
    });

  const connection = builder.build();
  activeConnection = connection;
  const refreshSnapshots = () => {
    onSnapshots({
      settings: [...connection.db.myFeedSettings.iter()],
      sensors: [...connection.db.mySensors.iter()],
      activities: [...connection.db.myActivity.iter()],
    });
  };
  const refreshOnChange = () => refreshSnapshots();
  for (const table of [
    connection.db.myFeedSettings,
    connection.db.mySensors,
    connection.db.myActivity,
  ]) {
    table.onInsert(refreshOnChange);
    table.onUpdate(refreshOnChange);
    table.onDelete(refreshOnChange);
  }

  const subscription = connection.subscriptionBuilder()
    .onApplied(() => {
      refreshSnapshots();
      connected = true;
      notifyStatus("connected");
      if (syncing) reconnectFlushRequested = true;
      void flushSnapshots();
    })
    .onError((ctx) => {
      connected = false;
      const error = ctx.event || new Error("The SpacetimeDB subscription was removed.");
      console.error("SpacetimeDB subscription failed.", error);
      notifyStatus("error", `Subscription failed: ${errorMessage(error)}`);
    })
    .subscribe([
      tables.myFeedSettings,
      tables.mySensors,
      tables.myActivity,
    ]);
  activeSubscription = subscription;

  return () => {
    connected = false;
    activeCallbacks = null;
    if (activeSubscription?.isActive()) activeSubscription.unsubscribe();
    activeSubscription = null;
    activeConnection?.disconnect();
    activeConnection = null;
    window.clearTimeout(flushTimer);
  };
}
