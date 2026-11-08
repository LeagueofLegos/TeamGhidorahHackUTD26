import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DEFAULT_NETWORK from "../HackUTD-ZeroDay-main/history/full_week/network.json";
import DEFAULT_OPS from "../HackUTD-ZeroDay-main/history/full_week/ops.json";
import { connectSpacetime, persistFeedSnapshot } from "./spacetime";
import {
  createDatasetContext,
  detectAlerts,
  parseSerialMessage,
  readDatasetFiles,
  validateSerialReading,
} from "./monitor";
import "./style.css";

const REFRESH_INTERVAL_MS = 150;
const MAX_SERIAL_HISTORY = 30_000;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeDefaultDataset() {
  return {
    ...createDatasetContext(DEFAULT_NETWORK, DEFAULT_OPS),
    readings: [],
    nowTs: 0,
  };
}

function toSeverityLevel(severity) {
  return severity === "alarm" ? 3 : severity === "warning" ? 2 : 1;
}

function fromDatabaseSnapshot({ sensors, activities }) {
  const activeAlerts = sensors
    .filter((sensor) => sensor.feed === "live" && !sensor.acknowledged)
    .map((sensor) => {
      const location = DEFAULT_NETWORK.systems.flatMap((system) => system.facilities.map((facility) => ({
        system,
        facility,
      }))).find(({ facility }) => (
        [facility.id, facility.tank.id, facility.pump.id, facility.pipeline.id,
          ...facility.wells.map((well) => well.id)].includes(sensor.area)
      ));
      return {
        id: sensor.sensorId,
        eventId: sensor.sensorId,
        assetId: sensor.area || sensor.sensorId,
        facilityId: location?.facility.id || "",
        facilityName: location?.facility.name || sensor.area || "Field site",
        systemId: location?.system.id || "",
        category: sensor.kind || "stored_alert",
        severity: sensor.severityLevel >= 3 ? "alarm" : sensor.severityLevel >= 2 ? "warning" : "normal",
        title: sensor.name,
        description: sensor.message,
        reading: sensor.value,
        observedAt: Math.floor(Number(sensor.startedAt) / 1000),
        status: "active",
        costGrowthPerSecond: sensor.costGrowthPerSecond,
      };
    });
  const siteLog = activities
    .filter((activity) => activity.feed === "live")
    .map((activity, index) => {
      const status = activity.text.endsWith(" · SOLVED")
        ? "solved"
        : activity.text.endsWith(" · ACKNOWLEDGED")
          ? "acknowledged"
          : activity.tone === "alarm" ? "active" : "cleared";
      return {
        eventId: `database:${activity.position}:${activity.time}`,
        title: activity.text.replace(/ · (SOLVED|ACKNOWLEDGED|CLEARED)$/, ""),
        status,
        severity: activity.tone === "alarm" ? "alarm" : activity.tone === "warning" ? "warning" : "normal",
        timestamp: Number(activity.time),
        databaseOrder: index,
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
  return { activeAlerts, siteLog };
}

function toDatabaseSnapshot(activeAlerts, siteLog) {
  const now = BigInt(Date.now());
  return {
    feed: "live",
    selectedSensorId: null,
    area: 1,
    zoom: 1,
    filter: "alerts",
    autoGenerateAlerts: false,
    lastCheck: now,
    alertStartedAt: now,
    sensors: activeAlerts.map((alert) => ({
      sensorId: alert.id,
      startedAt: BigInt((alert.observedAt || nowSeconds()) * 1000),
      generated: false,
      custom: false,
      name: alert.title,
      kind: alert.category,
      value: alert.reading || "",
      severityLevel: toSeverityLevel(alert.severity),
      x: 0,
      y: 0,
      area: alert.assetId,
      message: alert.description,
      advice: null,
      operations: alert.facilityName || null,
      timeToActSeconds: null,
      costGrowthPerSecond: alert.costGrowthPerSecond || 0,
      actions: [],
      acknowledged: false,
      dismissed: false,
      acknowledgedAt: null,
    })),
    activities: siteLog.slice(0, 100).map((entry) => ({
      time: BigInt(Math.floor(Number(entry.timestamp) || Date.now())),
      text: entry.status === "solved" || entry.status === "acknowledged" || entry.status === "cleared"
        ? `${entry.title} · ${entry.status.toUpperCase()}`
        : entry.title,
      tone: entry.status === "active" && entry.severity === "alarm"
        ? "alarm"
        : entry.status === "active" && entry.severity === "warning"
          ? "warning"
          : "normal",
    })),
  };
}

function playSiren(contextRef) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error("This browser does not support emergency alert audio.");
  contextRef.current ||= new AudioContext();
  const context = contextRef.current;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(640, start);
  oscillator.frequency.linearRampToValueAtTime(920, start + 0.18);
  oscillator.frequency.linearRampToValueAtTime(650, start + 0.36);
  oscillator.frequency.linearRampToValueAtTime(920, start + 0.54);
  oscillator.frequency.linearRampToValueAtTime(650, start + 0.72);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(0.07, start + 0.04);
  gain.gain.setValueAtTime(0.07, start + 0.5);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.76);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.78);
}

async function openSerialReader(onReading, onError, onDisconnected) {
  if (!window.isSecureContext || !("serial" in navigator)) {
    throw new Error("Web Serial requires a supported browser and a secure HTTPS or localhost connection.");
  }
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopped = false;
  const report = (error) => onError(error instanceof Error ? error.message : String(error));
  const consume = (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 64 * 1024 && !buffer.includes("\n")) {
          buffer = "";
          report(new Error("Ignored a sensor record longer than 64 KB."));
          continue;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              onReading(parseSerialMessage(line));
            } catch (error) {
              report(error);
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (!stopped) report(error);
    } finally {
      reader.releaseLock();
      if (port.readable) await port.close().catch(report);
      if (!stopped) onDisconnected();
    }
  })();
  return async () => {
    stopped = true;
    await reader.cancel().catch((error) => {
      if (port.readable) report(error);
    });
    await consume;
  };
}

function formatTime(seconds) {
  if (!seconds) return "—";
  const timestamp = Math.abs(seconds) > 1e12 ? seconds : seconds * 1000;
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function SeverityIcon({ severity }) {
  return <span className={`severity-icon ${severity}`} aria-hidden="true">
    {severity === "alarm" ? "!" : severity === "warning" ? "▲" : "✓"}
  </span>;
}

function FieldDiagram({ alerts, onSelect }) {
  const systems = new Map();
  for (const alert of alerts) {
    if (!systems.has(alert.systemId)) systems.set(alert.systemId, new Map());
    const facilities = systems.get(alert.systemId);
    if (!facilities.has(alert.facilityId)) facilities.set(alert.facilityId, []);
    facilities.get(alert.facilityId).push(alert);
  }
  const groups = [...systems.entries()].filter(([id]) => id);

  return <section className="panel diagram-panel" aria-labelledby="diagram-title">
    <div className="panel-heading">
      <div><p className="eyebrow">LIVE EQUIPMENT VIEW</p><h2 id="diagram-title">Field diagram</h2></div>
      <span className="count-badge">{alerts.length} ACTIVE</span>
    </div>
    {!alerts.length ? <div className="empty-state">
      <span className="empty-check">✓</span>
      <h3>No active alerts</h3>
      <p>The equipment diagram appears when sensor readings need attention.</p>
    </div> : <div className="diagram-scroll">
      {groups.map(([systemId, facilities]) => [...facilities.entries()].map(([facilityId, facilityAlerts]) => {
        const assetAlerts = new Map();
        for (const alert of facilityAlerts) {
          if (!assetAlerts.has(alert.assetId)) assetAlerts.set(alert.assetId, []);
          assetAlerts.get(alert.assetId).push(alert);
        }
        const facilityName = facilityAlerts[0].facilityName;
        const latestAlert = facilityAlerts[0];
        const components = [
          { key: "wells", label: "WELLS", assetId: null },
          { key: "tank", label: "TANK", assetId: facilityAlerts.find((alert) => alert.category.startsWith("tank_"))?.assetId },
          { key: "pump", label: "PUMP", assetId: facilityAlerts.find((alert) => alert.category.startsWith("pump_"))?.assetId },
          { key: "pipeline", label: "PIPELINE", assetId: facilityAlerts.find((alert) => alert.category === "pipeline_leak")?.assetId },
          { key: "disposal", label: "DISPOSAL", assetId: null },
        ];
        return <article className="facility-diagram" key={`${systemId}:${facilityId}`}>
          <div className="facility-heading">
            <b>{facilityName}</b><span>{systemId}</span>
          </div>
          <div className="flow-row" aria-label={`${facilityName} equipment flow`}>
            {components.map((component, index) => {
              const componentAlerts = component.assetId ? assetAlerts.get(component.assetId) || [] : [];
              const severity = componentAlerts.some((alert) => alert.severity === "alarm")
                ? "alarm"
                : componentAlerts.length ? "warning" : "normal";
              const content = <><span>{component.label}</span>{componentAlerts.length > 0
                && <small>{componentAlerts.map((alert) => alert.title).join(" · ")}</small>}</>;
              return <React.Fragment key={component.key}>
                {index > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
                {componentAlerts.length > 0
                  ? <button className={`flow-node ${severity}`} onClick={() => onSelect(componentAlerts[0])}>{content}</button>
                  : <div className={`flow-node ${severity}`}>{content}</div>}
              </React.Fragment>;
            })}
          </div>
          {facilityAlerts.map((alert) => <button
            className={`diagram-alert ${alert.severity}`}
            key={alert.eventId}
            onClick={() => onSelect(alert)}
          >
            <SeverityIcon severity={alert.severity} />
            <span><b>{alert.title}</b><small>{alert.assetId} · {alert.reading} · {formatTime(alert.observedAt)}</small></span>
            <span className="open-label">OPEN ALERT</span>
          </button>)}
          <span className="sr-only">{latestAlert.title}</span>
        </article>;
      }))}
    </div>}
  </section>;
}

function AlertDetails({ alert, onClose, onPin, onAcknowledge, onSolve }) {
  if (!alert) return null;
  const severityLabel = alert.severity === "alarm" ? "RED ALERT" : "YELLOW WARNING";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className={`alert-modal ${alert.severity}`} role="dialog" aria-modal="true" aria-labelledby="popup-title">
      <div className="alert-modal-header">
        <SeverityIcon severity={alert.severity} />
        <div><p className="eyebrow">{severityLabel} · {alert.assetId}</p><h2 id="popup-title">{alert.title}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close alert">×</button>
      </div>
      <p className="alert-description">{alert.description}</p>
      <dl className="reading-grid">
        <div><dt>READING</dt><dd>{alert.reading}</dd></div>
        <div><dt>OBSERVED</dt><dd>{formatTime(alert.observedAt)}</dd></div>
        <div><dt>FACILITY</dt><dd>{alert.facilityName}</dd></div>
      </dl>
      {alert.costGrowthPerSecond > 0 && <p className="cost-growth">
        Cost growth estimate <b>{formatMoney(alert.costGrowthPerSecond)}/sec</b>
      </p>}
      <div className="modal-actions">
        <button className="button secondary" onClick={onPin}>ADD TO ALERT DASHBOARD</button>
        <button className="button secondary" onClick={onAcknowledge}>ACKNOWLEDGE · REMOVE ALERT</button>
        <button className="button solve" onClick={onSolve}>SOLVED · REPORT GREEN</button>
      </div>
      <p className="read-only-note">Monitoring only · this display does not control equipment.</p>
    </section>
  </div>;
}

function App() {
  const [dataset, setDataset] = useState(makeDefaultDataset);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [siteLog, setSiteLog] = useState([]);
  const [dashboardIds, setDashboardIds] = useState([]);
  const [popupId, setPopupId] = useState(null);
  const [source, setSource] = useState("Waiting for telemetry");
  const [sourceError, setSourceError] = useState("");
  const [serialConnected, setSerialConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundError, setSoundError] = useState("");
  const [databaseStatus, setDatabaseStatus] = useState("connecting");
  const [databaseError, setDatabaseError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const inputRef = useRef(null);
  const serialStopRef = useRef(null);
  const audioContextRef = useRef(null);
  const previousDetectedRef = useRef(new Set());
  const suppressedRef = useRef(new Set());
  const acknowledgedRef = useRef(new Set());
  const readingHistoryRef = useRef([]);
  const processingTimerRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { activeAlerts, siteLog, dashboardIds, dataset, soundEnabled };

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const disconnect = connectSpacetime({
      onSnapshots: (snapshot) => {
        if (stateRef.current.dataset.readings.length || stateRef.current.activeAlerts.length) return;
        const restored = fromDatabaseSnapshot(snapshot);
        if (restored.activeAlerts.length) setActiveAlerts(restored.activeAlerts);
        if (restored.siteLog.length) setSiteLog(restored.siteLog);
      },
      onStatus: (status, message = "") => {
        setDatabaseStatus(status);
        setDatabaseError(message);
      },
    });
    return () => {
      disconnect();
      if (serialStopRef.current) void serialStopRef.current();
      window.clearTimeout(processingTimerRef.current);
      if (audioContextRef.current) void audioContextRef.current.close();
    };
  }, []);

  function persist(active, log) {
    persistFeedSnapshot("live", toDatabaseSnapshot(active, log));
  }

  function applyReadings(nextDataset) {
    const detected = detectAlerts(nextDataset);
    const detectedIds = new Set(detected.map((alert) => alert.id));
    const previousIds = previousDetectedRef.current;
    const suppressed = new Set(suppressedRef.current);
    const acknowledged = new Set(acknowledgedRef.current);
    const currentAlerts = new Map(stateRef.current.activeAlerts.map((alert) => [alert.id, alert]));
    let nextLog = [...stateRef.current.siteLog];
    let popup = null;

    for (const previousId of previousIds) {
      if (detectedIds.has(previousId)) continue;
      suppressed.delete(previousId);
      acknowledged.delete(previousId);
      const old = currentAlerts.get(previousId);
      if (old) {
        currentAlerts.delete(previousId);
        nextLog = nextLog.map((entry) => entry.eventId === old.eventId && entry.status === "active"
          ? { ...entry, status: "cleared", endedAt: Date.now() }
          : entry);
      }
    }

    for (const alert of detected) {
      const existing = currentAlerts.get(alert.id);
      if (suppressed.has(alert.id) || acknowledged.has(alert.id)) continue;
      if (existing) {
        currentAlerts.set(alert.id, { ...alert, eventId: existing.eventId });
      } else {
        const eventId = `${alert.id}:${alert.observedAt}`;
        const event = { ...alert, eventId, timestamp: Date.now(), status: "active" };
        currentAlerts.set(alert.id, event);
        nextLog.unshift(event);
        if (!popup && alert.severity === "alarm") popup = eventId;
      }
    }

    const nextActive = [...currentAlerts.values()].sort((a, b) => (
      (a.severity === "alarm" ? 0 : 1) - (b.severity === "alarm" ? 0 : 1)
      || b.observedAt - a.observedAt
    ));
    nextLog = nextLog.slice(0, 200);
    previousDetectedRef.current = detectedIds;
    suppressedRef.current = suppressed;
    acknowledgedRef.current = acknowledged;
    setActiveAlerts(nextActive);
    setSiteLog(nextLog);
    setDataset(nextDataset);
    if (popup) {
      setPopupId(popup);
      const alert = nextActive.find((item) => item.eventId === popup);
      if (alert && stateRef.current.soundEnabled) {
        try {
          playSiren(audioContextRef);
          setSoundError("");
        } catch (error) {
          setSoundError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    persist(nextActive, nextLog);
  }

  async function loadFiles(fileList) {
    setLoading(true);
    setSourceError("");
    try {
      const loaded = await readDatasetFiles(fileList);
      stateRef.current = {
        ...stateRef.current,
        activeAlerts: [],
        siteLog: [],
        dashboardIds: [],
        dataset: loaded,
      };
      setActiveAlerts([]);
      setSiteLog([]);
      setDashboardIds([]);
      readingHistoryRef.current = loaded.readings;
      previousDetectedRef.current = new Set();
      suppressedRef.current = new Set();
      acknowledgedRef.current = new Set();
      setSiteLog([]);
      setDashboardIds([]);
      setPopupId(null);
      setSource(`Dataset loaded · ${loaded.readings.length.toLocaleString()} readings`);
      applyReadings(loaded);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleSerialReading(reading) {
    try {
      validateSerialReading(stateRef.current.dataset, reading);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
      return;
    }
    const history = readingHistoryRef.current;
    const latestTs = history.at(-1)?.ts_unix || 0;
    if (reading.ts_unix < latestTs) {
      setSourceError("Ignored an out-of-order sensor reading.");
      return;
    }
    const nextHistory = [...history, reading].slice(-MAX_SERIAL_HISTORY);
    readingHistoryRef.current = nextHistory;
    const current = stateRef.current.dataset;
    const nextDataset = { ...current, readings: nextHistory, nowTs: reading.ts_unix };
    window.clearTimeout(processingTimerRef.current);
    processingTimerRef.current = window.setTimeout(() => {
      setSourceError("");
      applyReadings(nextDataset);
    }, REFRESH_INTERVAL_MS);
  }

  async function toggleSerial() {
    setSourceError("");
    if (serialStopRef.current) {
      const stop = serialStopRef.current;
      serialStopRef.current = null;
      await stop();
      setSerialConnected(false);
      setSource("Serial connection closed");
      return;
    }
    try {
      const stop = await openSerialReader(handleSerialReading, setSourceError, () => {
        serialStopRef.current = null;
        setSerialConnected(false);
        setSource("Serial connection ended");
      });
      serialStopRef.current = stop;
      readingHistoryRef.current = [];
      previousDetectedRef.current = new Set();
      suppressedRef.current = new Set();
      acknowledgedRef.current = new Set();
      const connectedDataset = {
        ...stateRef.current.dataset,
        readings: [],
        nowTs: 0,
      };
      stateRef.current = {
        ...stateRef.current,
        activeAlerts: [],
        siteLog: [],
        dashboardIds: [],
        dataset: connectedDataset,
      };
      setActiveAlerts([]);
      setSiteLog([]);
      setDashboardIds([]);
      setDataset(connectedDataset);
      setSerialConnected(true);
      setSource("Serial telemetry · 115200 baud");
      setSourceError("");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    }
  }

  function findAlertByEvent(eventId) {
    return stateRef.current.activeAlerts.find((alert) => alert.eventId === eventId)
      || stateRef.current.siteLog.find((entry) => entry.eventId === eventId);
  }

  function addToDashboard(alert) {
    setDashboardIds((ids) => ids.includes(alert.eventId) ? ids : [alert.eventId, ...ids]);
    setPopupId(null);
  }

  function acknowledge(alert) {
    acknowledgedRef.current = new Set([...acknowledgedRef.current, alert.id]);
    const nextActive = stateRef.current.activeAlerts.filter((item) => item.eventId !== alert.eventId);
    const nextLog = stateRef.current.siteLog.map((entry) => entry.eventId === alert.eventId
      ? { ...entry, status: "acknowledged", endedAt: Date.now() }
      : entry);
    setActiveAlerts(nextActive);
    setSiteLog(nextLog);
    setPopupId(null);
    persist(nextActive, nextLog);
  }

  function solve(alert) {
    suppressedRef.current = new Set([...suppressedRef.current, alert.id]);
    const nextActive = stateRef.current.activeAlerts.filter((item) => item.eventId !== alert.eventId);
    const nextLog = stateRef.current.siteLog.map((entry) => entry.eventId === alert.eventId
      ? { ...entry, status: "solved", severity: "normal", endedAt: Date.now() }
      : entry);
    setActiveAlerts(nextActive);
    setSiteLog(nextLog);
    setPopupId(null);
    persist(nextActive, nextLog);
  }

  function enableSound() {
    try {
      playSiren(audioContextRef);
      setSoundEnabled(true);
      setSoundError("");
    } catch (error) {
      setSoundError(error instanceof Error ? error.message : String(error));
    }
  }

  function openAlert(alert) {
    setPopupId(alert.eventId);
    if (alert.severity === "alarm") {
      setDashboardIds((ids) => ids.includes(alert.eventId) ? ids : [alert.eventId, ...ids]);
    }
  }

  const popupAlert = popupId ? findAlertByEvent(popupId) : null;
  const dashboardAlerts = dashboardIds.map(findAlertByEvent).filter(Boolean);
  const activeAlarmCount = activeAlerts.filter((alert) => alert.severity === "alarm").length;
  const activeWarningCount = activeAlerts.filter((alert) => alert.severity === "warning").length;
  const hasTelemetry = dataset.nowTs > 0;
  const isDatasetReview = source.startsWith("Dataset loaded");
  const isSerialSource = source.startsWith("Serial");
  const telemetryStale = isSerialSource
    && (!serialConnected || nowSeconds() - dataset.nowTs > 7 * 60);
  const waitingForData = !hasTelemetry;
  const statusSeverity = activeAlarmCount
    ? "alarm"
    : activeWarningCount || waitingForData || isDatasetReview || telemetryStale
      ? "warning"
      : "normal";
  const statusLabel = activeAlerts.length
    ? `${activeAlerts.length} ACTIVE ALERT${activeAlerts.length === 1 ? "" : "S"}`
    : waitingForData ? "WAITING FOR DATA"
      : isDatasetReview ? "DATASET REVIEW"
        : telemetryStale ? "TELEMETRY STALE"
          : "ALL CLEAR";

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">⛽</span>
        <div><b>FIELD MONITOR</b><span>OIL &amp; WATER OPERATIONS</span></div>
      </div>
      <div className={`site-status ${statusSeverity}`}>
        <SeverityIcon severity={statusSeverity} />
        <span><b>{statusLabel}</b>
          <small>{hasTelemetry ? `${activeAlarmCount} red · ${activeWarningCount} yellow` : "No sensor reading received"}</small></span>
      </div>
      <div className="header-controls">
        <label className={`button file-button ${loading ? "disabled" : ""}`}>
          {loading ? "LOADING DATA…" : "LOAD DATA"}
          <input
            ref={inputRef}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            multiple
            disabled={loading}
            onChange={(event) => void loadFiles(event.target.files || [])}
            aria-label="Load network.json, ops.json, and telemetry.csv"
          />
        </label>
        <button className={`button ${serialConnected ? "connected" : "secondary"}`} onClick={() => void toggleSerial()}>
          {serialConnected ? "DISCONNECT SENSOR" : "CONNECT SENSOR"}
        </button>
        <button className={`button ${soundEnabled ? "connected" : "secondary"}`} onClick={soundEnabled ? undefined : enableSound}>
          {soundEnabled ? "SOUND ON" : "ENABLE SOUND"}
        </button>
      </div>
    </header>

    <div className="source-bar">
      <span className={`source-light ${serialConnected ? "online" : ""}`} />
      <span>{source}</span>
      {!serialConnected && <small>Load network.json, ops.json &amp; telemetry.csv, or connect a Web Serial sensor.</small>}
    </div>
    {(sourceError || soundError) && <div className="error-banner" role="alert">{sourceError || soundError}</div>}

    <main className="workspace">
      <div className="primary-column">
        <FieldDiagram alerts={activeAlerts} onSelect={openAlert} />
        <section className="panel site-log-panel" aria-labelledby="site-log-title">
          <div className="panel-heading">
            <div><p className="eyebrow">EVENT HISTORY</p><h2 id="site-log-title">Site log</h2></div>
            <span className="count-badge">{siteLog.length} ENTRIES</span>
          </div>
          {!siteLog.length ? <p className="empty-log">No alert activity recorded.</p> : <div className="log-list">
            {siteLog.map((entry) => <article className={`log-entry ${entry.status}`} key={entry.eventId}>
              <SeverityIcon severity={entry.status === "solved" ? "normal" : entry.severity} />
              <div className="log-copy">
                <b>{entry.title}</b>
                <span>{entry.assetId || ""} · {formatTime(entry.timestamp || entry.observedAt)}</span>
              </div>
              <span className={`log-status ${entry.status}`}>{entry.status.toUpperCase()}</span>
              {entry.status === "active" && <button className="button solve small" onClick={() => solve(entry)}>SOLVED</button>}
              {entry.status === "active" && entry.severity === "alarm" && <button className="button secondary small" onClick={() => acknowledge(entry)}>ACKNOWLEDGE</button>}
            </article>)}
          </div>}
        </section>
      </div>

      <aside className="side-column">
        <section className="panel dashboard-panel" aria-labelledby="dashboard-title">
          <div className="panel-heading">
            <div><p className="eyebrow">ALERTS YOU OPENED</p><h2 id="dashboard-title">Alert dashboard</h2></div>
            <span className="count-badge">{dashboardAlerts.length}</span>
          </div>
          {!dashboardAlerts.length ? <p className="empty-log">Click an alert on the equipment diagram to keep it here.</p>
            : <div className="dashboard-list">
              {dashboardAlerts.map((alert) => <article className={`dashboard-card ${alert.status === "solved" ? "normal" : alert.severity}`} key={alert.eventId}>
                <div className="dashboard-card-heading"><SeverityIcon severity={alert.status === "solved" ? "normal" : alert.severity} /><b>{alert.title}</b></div>
                <p>{alert.description}</p>
                <small>{alert.assetId} · {formatTime(alert.observedAt || alert.timestamp / 1000)}</small>
                {alert.status && alert.status !== "active" && <span className={`log-status ${alert.status}`}>{alert.status.toUpperCase()}</span>}
                {alert.status === "active" && <div className="dashboard-actions">
                  <button className="button secondary small" onClick={() => acknowledge(alert)}>ACKNOWLEDGE</button>
                  {alert.severity !== "alarm" && <button className="button solve small" onClick={() => solve(alert)}>SOLVED</button>}
                </div>}
              </article>)}
            </div>}
        </section>
        <section className="panel source-panel" aria-label="Sensor input details">
          <p className="eyebrow">INPUT STATUS</p>
          <p><b>{serialConnected ? "Sensor connected" : "Read-only monitoring"}</b></p>
          <small>Serial messages: one JSON object per line with asset_id, metric, value, and ts_unix. Port: 115200 baud. This page does not send control commands.</small>
          <div className="database-indicator" title={databaseError || "SpacetimeDB connection status"}>
            <i className={databaseStatus} /> DATABASE {databaseStatus.toUpperCase()}
          </div>
        </section>
      </aside>
    </main>
    <footer className="footerbar">
      <span>READ-ONLY MONITORING · HARDWARE ACTIONS REQUIRE AN AUTHORIZED CONTROL SYSTEM</span>
      <span>LAST READING: {formatTime(dataset.nowTs)} · {new Date(clock).toLocaleTimeString()}</span>
    </footer>
    <AlertDetails
      alert={popupAlert}
      onClose={() => setPopupId(null)}
      onPin={() => popupAlert && addToDashboard(popupAlert)}
      onAcknowledge={() => popupAlert && acknowledge(popupAlert)}
      onSolve={() => popupAlert && solve(popupAlert)}
    />
  </div>;
}

const root = globalThis.__oilerAppRoot || createRoot(document.getElementById("root"));
globalThis.__oilerAppRoot = root;
root.render(<App />);
