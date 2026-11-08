import {
  backendActions,
  startBackend,
  subscribeBackend,
  getBackendState,
} from "./backend.js";
import { adaptSensors, readJson } from "./backendAdapter.js";
import { BackendPanel } from "./BackendPanel.jsx";
import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { Button, Classes } from "@blueprintjs/core";
import { GoldenLayout } from "golden-layout";
import "@blueprintjs/core/lib/css/blueprint.css";
import "golden-layout/dist/css/goldenlayout-base.css";
import "golden-layout/dist/css/themes/goldenlayout-dark-theme.css";
import "./style.css";
import "./backend.css";

const sensors = [];

const initialActivity = [
  {
    time: Date.now(),
    text: "Monitoring ready · no active alerts",
    tone: "normal",
  },
];

const listeners = new Set();
let appState = {
  sensors,
  selectedSensorId: null,
  area: 400,
  zoom: 1,
  filter: "all",
  acknowledged: {},
  activity: initialActivity,
  notice: "",
  lastCheck: Date.now(),
  alertStartedAt: Date.now(),
  now: Date.now(),
  soundPermission: null,
  dismissedEmergencies: {},
  acknowledgedAt: {},
  feedMode: "backend",
  autoGenerateAlerts: false,
};

const feedStateKeys = [
  "sensors",
  "selectedSensorId",
  "area",
  "zoom",
  "filter",
  "acknowledged",
  "activity",
  "notice",
  "lastCheck",
  "alertStartedAt",
  "now",
  "dismissedEmergencies",
  "acknowledgedAt",
  "autoGenerateAlerts",
];

function copyFeedState(state) {
  return Object.fromEntries(feedStateKeys.map((key) => [key, state[key]]));
}

const feedStates = {
  backend: copyFeedState(appState),
  simulated: copyFeedState(appState),
  live: {
    ...copyFeedState(appState),
    sensors: [],
    selectedSensorId: null,
    acknowledged: {},
    dismissedEmergencies: {},
    acknowledgedAt: {},
    activity: [
      {
        time: Date.now(),
        text: "Live simulation ready · no active alerts",
        tone: "normal",
      },
    ],
    lastCheck: Date.now(),
    alertStartedAt: Date.now(),
    now: Date.now(),
    autoGenerateAlerts: false,
  },
};

const randomIssues = [
  {
    kind: "Gas",
    names: ["Gas reading high", "Gas sensor alert", "Air reading above normal"],
    values: ["11 ppm", "14 ppm", "9 ppm"],
  },
  {
    kind: "Pressure",
    names: [
      "Line pressure rising",
      "Pressure change detected",
      "Separator pressure high",
    ],
    values: ["224 psi", "231 psi", "219 psi"],
  },
  {
    kind: "Temperature",
    names: [
      "Bearing temperature high",
      "Motor running warm",
      "Temperature change detected",
    ],
    values: ["79 °C", "83 °C", "76 °C"],
  },
  {
    kind: "Vibration",
    names: [
      "Pump vibration increased",
      "Motor vibration alert",
      "Bearing vibration high",
    ],
    values: ["8.4 mm/s", "9.1 mm/s", "7.9 mm/s"],
  },
  {
    kind: "Fire / smoke",
    names: [
      "Smoke detector alert",
      "Heat detector activated",
      "Fire loop alert",
    ],
    values: ["SMOKE", "HEAT", "CHECK"],
  },
];
const randomLocations = [
  "Well deck",
  "Pump house",
  "Tank farm",
  "Process area",
  "North perimeter",
  "Power house",
  "South access",
];

function currentSensors() {
  return appState.sensors;
}

function addRandomAlert() {
  const issue = randomIssues[Math.floor(Math.random() * randomIssues.length)];
  const state = ["alarm", "warning", "normal"][Math.floor(Math.random() * 3)];
  const location =
    randomLocations[Math.floor(Math.random() * randomLocations.length)];
  const index = Math.floor(Math.random() * issue.names.length);
  const id = `sample-${Date.now()}`;
  const sensor = {
    id,
    startedAt: Date.now(),
    generated: true,
    name: `${issue.names[index]} · ${location.toLowerCase()}`,
    kind: issue.kind,
    value: issue.values[index],
    severityLevel: severityLevelFromState(state),
    x: 16 + Math.random() * 68,
    y: 17 + Math.random() * 66,
    area: location,
    message:
      state === "normal"
        ? `${issue.kind} reading is in the usual range.`
        : `${issue.kind} reading needs attention.`,
    ...(state !== "normal"
      ? {
          advice:
            state === "alarm"
              ? "Move away if needed and follow your site's emergency response procedure."
              : "Check the reading and follow your site's operating procedure.",
          operations: `${location} · nearby work area`,
          timeToActSeconds:
            state === "alarm"
              ? 45 + Math.floor(Math.random() * 90)
              : 180 + Math.floor(Math.random() * 600),
          costGrowthPerSecond:
            state === "alarm"
              ? 1.2 + Math.random() * 1.8
              : 0.05 + Math.random() * 0.25,
          actions: [
            { name: "Review site response procedure", baseCost: 4 },
            { name: "Contact the site lead", baseCost: 7 },
          ],
        }
      : {}),
  };
  const time = Date.now();
  appState = {
    ...appState,
    sensors: [...currentSensors(), sensor],
    lastCheck: time,
    selectedSensorId: id,
    activity: [
      {
        time,
        text: `${sensor.name} · ${state === "alarm" ? "red alert" : state === "warning" ? "yellow alert" : "green reading"}`,
        tone:
          state === "alarm"
            ? "alarm"
            : state === "warning"
              ? "warning"
              : "normal",
      },
      ...appState.activity,
    ].slice(0, 10),
    notice: `New ${state === "alarm" ? "red" : state === "warning" ? "yellow" : "green"} sample at ${location}.`,
  };
  notify();
}

function deleteLastGeneratedAlert() {
  const generated = currentSensors()
    .filter((sensor) => sensor.generated)
    .sort((a, b) => b.startedAt - a.startedAt);
  const lastAlert = generated[0];
  if (!lastAlert) {
    recordAction("There are no generated alerts to delete.");
    return;
  }
  const remainingSensors = currentSensors().filter(
    (sensor) => sensor.id !== lastAlert.id,
  );
  const time = Date.now();
  const acknowledged = { ...appState.acknowledged };
  const dismissedEmergencies = { ...appState.dismissedEmergencies };
  const acknowledgedAt = { ...appState.acknowledgedAt };
  delete acknowledged[lastAlert.id];
  delete dismissedEmergencies[lastAlert.id];
  delete acknowledgedAt[lastAlert.id];
  appState = {
    ...appState,
    sensors: remainingSensors,
    selectedSensorId:
      appState.selectedSensorId === lastAlert.id
        ? (remainingSensors[remainingSensors.length - 1]?.id ?? null)
        : appState.selectedSensorId,
    acknowledged,
    dismissedEmergencies,
    acknowledgedAt,
    notice: `Removed the last generated alert: ${lastAlert.name}.`,
    activity: [
      {
        time,
        text: `Last generated alert removed · ${lastAlert.name}`,
        tone: "normal",
      },
      ...appState.activity,
    ].slice(0, 10),
  };
  notify();
}

function addCustomLiveAlert(alert) {
  if (appState.feedMode !== "live") return;
  const time = Date.now();
  const sensor = {
    ...alert,
    id: `live-custom-${time}`,
    startedAt: time,
    generated: true,
    custom: true,
    x: 16 + Math.random() * 68,
    y: 17 + Math.random() * 66,
  };
  appState = {
    ...appState,
    sensors: [...currentSensors(), sensor],
    selectedSensorId: sensor.id,
    lastCheck: time,
    acknowledged: { ...appState.acknowledged, [sensor.id]: false },
    dismissedEmergencies: {
      ...appState.dismissedEmergencies,
      [sensor.id]: false,
    },
    notice: `Custom ${severityState(sensor) === "alarm" ? "red" : severityState(sensor) === "warning" ? "yellow" : "green"} alert created in Live Sim.`,
    activity: [
      {
        time,
        text: `Custom alert created · ${sensor.name}`,
        tone:
          severityState(sensor) === "alarm"
            ? "alarm"
            : severityState(sensor) === "warning"
              ? "warning"
              : "normal",
      },
      ...appState.activity,
    ].slice(0, 10),
  };
  notify();
}

function applyBackend(backend) {
  if (appState.feedMode !== "backend") return;
  const next = adaptSensors(backend.view, backend.connected),
    acknowledged = Object.fromEntries(next.map((s) => [s.id, s.acknowledged]));
  const sameSession =
    appState.backend?.view?.state?.session === backend.view?.state?.session;
  appState = {
    ...appState,
    sensors: next,
    backend,
    acknowledged,
    selectedSensorId:
      sameSession && next.some((s) => s.id === appState.selectedSensorId)
        ? appState.selectedSensorId
        : (next.find((s) => s.severityLevel > 1)?.id ?? next[0]?.id ?? null),
    lastCheck: backend.view?.state?.receivedMs ?? Date.now(),
    activity: (backend.view?.events ?? [])
      .slice()
      .sort((a, b) => b.onsetTs - a.onsetTs)
      .slice(0, 10)
      .map((e) => ({
        time: e.onsetTs * 1000,
        text: e.facilityId + " · " + e.category + " · " + e.status,
        tone: e.status === "ongoing" ? "warning" : "normal",
      })),
  };
  notify();
}
subscribeBackend(applyBackend);
function setFeedMode(mode) {
  if (mode === appState.feedMode) return;
  feedStates[appState.feedMode] = copyFeedState(appState);
  appState = {
    ...appState,
    ...feedStates[mode],
    feedMode: mode,
    notice:
      mode === "live"
        ? "Live simulation started. Its alerts and map are separate from the simulated feed."
        : "Simulated feed selected. Its alerts and map are separate from Live Sim.",
  };
  if (mode === "backend") applyBackend(getBackendState());
  else notify();
}

function toggleAutoGenerateAlerts() {
  const enabled = !appState.autoGenerateAlerts;
  updateState({
    autoGenerateAlerts: enabled,
    notice: enabled
      ? "Automatic sample alerts are on for the Simulated feed."
      : "Automatic sample alerts are off.",
  });
}

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useAppState() {
  return useSyncExternalStore(subscribe, () => appState);
}

function updateState(changes) {
  appState = { ...appState, ...changes };
  notify();
}

function timeNow() {
  return Date.now();
}

function recordAction(text, tone = "normal") {
  const time = timeNow();
  appState = {
    ...appState,
    notice: text,
    activity: [{ time, text, tone }, ...appState.activity].slice(0, 10),
  };
  notify();
}

function selectSensor(id) {
  updateState({ selectedSensorId: id, notice: "" });
}

function acknowledge(sensor) {
  if (sensor.backend) {
    backendActions
      .acknowledge(sensor.alertIds)
      .then(() =>
        recordAction(
          "Acknowledged in the backend; forecasts and protection remain active.",
        ),
      )
      .catch((e) => recordAction(e.message, "warning"));
    return;
  }
  if (appState.acknowledged[sensor.id]) {
    recordAction(`${sensor.name}: already acknowledged.`);
    return;
  }
  const acknowledged = { ...appState.acknowledged, [sensor.id]: true };
  const dismissedEmergencies = {
    ...appState.dismissedEmergencies,
    [sensor.id]: true,
  };
  const time = timeNow();
  const acknowledgedAt = {
    ...appState.acknowledgedAt,
    [sensor.id]: Date.now(),
  };
  appState = {
    ...appState,
    acknowledged,
    acknowledgedAt,
    dismissedEmergencies,
    notice: `${sensor.name} marked complete in this demo. This does not confirm the condition has cleared.`,
    activity: [
      { time, text: `${sensor.name} alert acknowledged`, tone: "normal" },
      ...appState.activity,
    ].slice(0, 10),
  };
  notify();
}

function dismissEmergency(sensor) {
  const dismissedEmergencies = {
    ...appState.dismissedEmergencies,
    [sensor.id]: true,
  };
  const time = timeNow();
  appState = {
    ...appState,
    selectedSensorId: sensor.id,
    dismissedEmergencies,
    notice: `${sensor.name} moved to the side-panel alert. Acknowledge it there to complete this demo alert.`,
    activity: [
      { time, text: `${sensor.name} popup moved to side panel`, tone: "alarm" },
      ...appState.activity,
    ].slice(0, 10),
  };
  notify();
}

function chooseEmergencySound() {
  const popupVisible = activeEmergencies().some(
    (sensor) => !appState.dismissedEmergencies[sensor.id],
  );
  const played = popupVisible ? playEmergencySiren() : false;
  updateState({
    soundPermission: "allowed",
    notice: played
      ? "Emergency sound enabled for this session."
      : "Emergency sound enabled. No new siren was needed.",
  });
}

function setEmergencySoundOff() {
  updateState({ soundPermission: "declined" });
}

function replayEmergencySound() {
  if (playEmergencySiren())
    recordAction(
      "Demo emergency sound test played. No equipment action was taken.",
    );
}

function formatTime(time) {
  return new Date(time).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function isAlert(sensor) {
  return severityState(sensor) !== "normal";
}

function severityLevelFromState(state) {
  if (state === "alarm") return 3;
  if (state === "warning" || state === "watch") return 2;
  return 1;
}

function severityState(sensor) {
  const level = Number(sensor.severityLevel);
  if (Number.isFinite(level)) {
    return ["normal", "warning", "alarm"][
      Math.max(1, Math.min(3, Math.round(level))) - 1
    ];
  }
  return sensor.state || "normal";
}

function severityFor(sensor) {
  const state = severityState(sensor);
  if (state === "alarm") return "alarm";
  if (state === "warning" || state === "watch") return "warning";
  return "normal";
}

function activeEmergencies(acknowledged = appState.acknowledged) {
  return currentSensors()
    .filter(
      (sensor) => severityState(sensor) === "alarm" && !acknowledged[sensor.id],
    )
    .sort(
      (a, b) =>
        b.costGrowthPerSecond - a.costGrowthPerSecond ||
        a.timeToActSeconds - b.timeToActSeconds,
    );
}

function elapsedSeconds(sensor, now = appState.now) {
  const stoppedAt = appState.acknowledgedAt[sensor.id];
  return Math.max(
    0,
    Math.floor(
      ((stoppedAt || now) - (sensor.startedAt || appState.alertStartedAt)) /
        1000,
    ),
  );
}

function remainingSeconds(sensor, now = appState.now) {
  if (sensor.backend) return sensor.timeToActSeconds;
  if (sensor.timeToActSeconds === null || sensor.timeToActSeconds === undefined)
    return null;
  return sensor.timeToActSeconds - elapsedSeconds(sensor, now);
}

function formatDuration(seconds) {
  const absolute = Math.floor(Math.abs(seconds));
  if (absolute >= 3600)
    return `${Math.floor(absolute / 3600)}h ${Math.floor((absolute % 3600) / 60)}m`;
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatMoney(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatMoneyRate(amount) {
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}/sec`;
}

function actionCost(sensor, action, now = appState.now) {
  if (sensor.backend) return action.baseCost;
  return (
    action.baseCost + elapsedSeconds(sensor, now) * sensor.costGrowthPerSecond
  );
}

let sirenContext;

function playEmergencySiren() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    recordAction(
      "This browser cannot play the demo siren. The visual emergency alert is still active.",
      "alarm",
    );
    return false;
  }
  try {
    sirenContext ||= new AudioContext();
    const oscillator = sirenContext.createOscillator();
    const gain = sirenContext.createGain();
    const start = sirenContext.currentTime;
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
    gain.connect(sirenContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.78);
    return true;
  } catch (error) {
    console.error("Could not play the simulated emergency sound.", error);
    recordAction(
      "Could not play the demo siren. The visual emergency alert is still active.",
      "alarm",
    );
    return false;
  }
}

function SeveritySymbol({ severity, className = "" }) {
  const isEmergency = severity === "alarm";
  return (
    <span
      className={`severity-symbol ${severity} ${className}`}
      role="img"
      aria-label={
        isEmergency
          ? "Emergency siren"
          : severity === "warning"
            ? "Attention exclamation"
            : "Normal exclamation"
      }
    >
      {isEmergency ? (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M8 21v-7a8 8 0 0 1 16 0v7l3 3H5l3-3Z" />
          <path
            d="M12 27a4 4 0 0 0 8 0M16 1v3M5 5l3 3M27 5l-3 3M2 14h4M26 14h4"
            className="siren-rays"
          />
        </svg>
      ) : (
        <span aria-hidden="true">!</span>
      )}
    </span>
  );
}

function UrgencyTimer({ sensor, now, acknowledged = false, compact = false }) {
  if (sensor.timeToActSeconds === null || sensor.timeToActSeconds === undefined)
    return null;
  const remaining = remainingSeconds(sensor, now);
  const overdue = remaining <= 0;
  const ratio = Math.max(
    0,
    Math.min(1, remaining / Math.max(1, sensor.timeToActSeconds)),
  );
  const circumference = 2 * Math.PI * 17;
  const timeCopy = sensor.backend
    ? sensor.timeToActSeconds === 0
      ? sensor.etaState === "field_shutdown"
        ? "FIELD SHUT DOWN"
        : "THRESHOLD REACHED"
      : formatDuration(sensor.timeToActSeconds) + " TO SHUTDOWN"
    : overdue
      ? `OVERDUE +${formatDuration(remaining)}`
      : `${formatDuration(remaining)} LEFT`;
  return (
    <div
      className={`urgency-timer ${compact ? "compact" : ""} ${overdue ? "overdue" : ""} ${acknowledged ? "acknowledged" : ""}`}
      role="img"
      aria-label={
        acknowledged
          ? `${sensor.name} alert acknowledged`
          : `${sensor.name}, ${overdue ? "overdue" : `${formatDuration(remaining)} remaining to act`}`
      }
    >
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="timer-track" cx="22" cy="22" r="17" />
        <circle
          className="timer-progress"
          cx="22"
          cy="22"
          r="17"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
        <text x="22" y="26" textAnchor="middle">
          {acknowledged ? "✓" : overdue ? "!" : "!"}
        </text>
      </svg>
      <span className="timer-copy">
        <b>{acknowledged && !sensor.backend ? "ACKNOWLEDGED" : timeCopy}</b>
        <small>
          {sensor.backend
            ? sensor.etaBasis
            : acknowledged
              ? "DEMO RECORD"
              : "EST. TIME TO ACT"}
        </small>
      </span>
    </div>
  );
}

function Header() {
  const {
    area,
    acknowledged,
    soundPermission,
    feedMode,
    sensors: siteSensors,
    autoGenerateAlerts,
  } = useAppState();
  const [showCustomAlertForm, setShowCustomAlertForm] = useState(false);
  const areaOptions = feedMode === "backend" ? [] : [160, 400, 640];
  const emergencyCount = activeEmergencies(acknowledged).length;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span>O</span>
        </div>
        <div>
          <div className="brand-name">
            NORTH PIER <b>04</b>
          </div>
          <div className="brand-caption">SITE MONITOR</div>
        </div>
      </div>
      <div className="site-status">
        <SeveritySymbol
          severity={emergencyCount ? "alarm" : "normal"}
          className="header-severity-icon"
        />
        <span
          className={`site-status-text ${emergencyCount ? "emergency" : ""}`}
        >
          <b>
            {emergencyCount
              ? `${emergencyCount} EMERGENCY ${emergencyCount === 1 ? "ALERT" : "ALERTS"}`
              : "NO ACTIVE ALERTS"}
          </b>
          <span>
            {emergencyCount
              ? "Review the selected alert"
              : "No sample alerts are active"}
          </span>
        </span>
      </div>
      <div className="header-right">
        <div className="area-control" aria-label="Site boundary area">
          <span>{feedMode === "backend" ? "FIELD VIEW" : "SITE AREA"}</span>
          {areaOptions.map((option) => (
            <button
              key={option}
              className={`area-button ${area === option ? "selected" : ""}`}
              onClick={() => updateState({ area: option })}
            >
              {option} <small>ac</small>
            </button>
          ))}
        </div>
        <div className="feed-switch" aria-label="Sensor feed mode">
          <button
            className={feedMode === "backend" ? "selected live" : ""}
            onClick={() => setFeedMode("backend")}
          >
            BACKEND
          </button>
          <button
            className={feedMode === "simulated" ? "selected" : ""}
            onClick={() => setFeedMode("simulated")}
          >
            UI SAMPLES
          </button>
          <button
            className={feedMode === "live" ? "selected live" : ""}
            onClick={() => setFeedMode("live")}
          >
            {feedMode === "live" && <span className="feed-light" />} CUSTOM
            SAMPLES
          </button>
        </div>
        {feedMode === "simulated" && (
          <>
            <button className="random-alert-button" onClick={addRandomAlert}>
              + RANDOM ALERT
            </button>
            <button
              className={`auto-alert-button ${autoGenerateAlerts ? "enabled" : ""}`}
              onClick={toggleAutoGenerateAlerts}
            >
              AUTO ALERTS: {autoGenerateAlerts ? "ON" : "OFF"}
            </button>
          </>
        )}
        {feedMode === "simulated" && (
          <button
            className="delete-alert-button"
            onClick={deleteLastGeneratedAlert}
            disabled={!siteSensors.some((sensor) => sensor.generated)}
          >
            DELETE LAST ALERT
          </button>
        )}
        {feedMode === "live" && (
          <button
            className="custom-alert-button"
            onClick={() => setShowCustomAlertForm(true)}
          >
            + CREATE ALERT
          </button>
        )}
        <div className="sound-controls">
          {soundPermission === "allowed" ? (
            <>
              <button className="sound-status" onClick={replayEmergencySound}>
                TEST SIREN
              </button>
              <button
                className="sound-status mute"
                onClick={setEmergencySoundOff}
              >
                MUTE
              </button>
            </>
          ) : (
            <button className="sound-status" onClick={chooseEmergencySound}>
              ENABLE SOUND
            </button>
          )}
        </div>
      </div>
      {showCustomAlertForm && (
        <CustomAlertForm
          onClose={() => setShowCustomAlertForm(false)}
          onSave={(alert) => {
            addCustomLiveAlert(alert);
            setShowCustomAlertForm(false);
          }}
        />
      )}
    </header>
  );
}

function SiteMap() {
  const {
    selectedSensorId,
    area,
    zoom,
    filter,
    sensors: siteSensors,
    now,
    acknowledged,
    feedMode,
  } = useAppState();
  const planWrapRef = useRef(null);
  const [sensorHitRadius, setSensorHitRadius] = useState(34);
  const areaScale = Math.sqrt(area / 400);
  const scale = zoom;
  const siteWidth = 780 * areaScale;
  const siteHeight = 464 * areaScale;
  const facilityScale = Math.min(1, areaScale);
  const facilityOffsetX = (siteWidth - 780 * facilityScale) / 2;
  const facilityOffsetY = (siteHeight - 464 * facilityScale) / 2;
  const shownSensors = siteSensors.filter(
    (sensor) => filter === "all" || isAlert(sensor),
  );

  useEffect(() => {
    const planWrap = planWrapRef.current;
    if (!planWrap) return undefined;
    const updateHitRadius = () => {
      const svg = planWrap.querySelector("svg");
      const viewScale =
        Math.min(svg.clientWidth / 1100, svg.clientHeight / 700) * scale;
      if (viewScale > 0) setSensorHitRadius(Math.ceil(22 / viewScale));
    };
    const observer = new ResizeObserver(updateHitRadius);
    observer.observe(planWrap);
    updateHitRadius();
    return () => observer.disconnect();
  }, [scale]);

  return (
    <section className="site-panel" aria-label="Rig site plan">
      <div className="map-topline">
        <div>
          <div className="eyebrow">
            SITE PLAN <span className="current-site">NORTH PIER 04</span>
          </div>
          <div className="map-title">
            {feedMode === "backend"
              ? "Field facilities · schematic"
              : "Rig & sensor locations"}
          </div>
        </div>
        <div className="map-tools">
          <button
            className={`map-filter ${filter === "all" ? "active" : ""}`}
            onClick={() => updateState({ filter: "all" })}
          >
            ALL SENSORS <span>{siteSensors.length}</span>
          </button>
          <button
            className={`map-filter ${filter === "alerts" ? "active" : ""}`}
            onClick={() => updateState({ filter: "alerts" })}
          >
            NEEDS ATTENTION <span>{siteSensors.filter(isAlert).length}</span>
          </button>
          <div className="zoom-control" aria-label="Plan zoom">
            <button
              aria-label="Zoom in"
              onClick={() =>
                updateState({ zoom: Math.min(1.35, +(zoom + 0.1).toFixed(2)) })
              }
            >
              +
            </button>
            <button
              aria-label="Zoom out"
              onClick={() =>
                updateState({ zoom: Math.max(0.75, +(zoom - 0.1).toFixed(2)) })
              }
            >
              −
            </button>
          </div>
        </div>
      </div>
      <div className="plan-wrap" ref={planWrapRef}>
        <svg
          className="site-plan"
          viewBox="0 0 1100 700"
          role="img"
          aria-label={`Top-down rig site plan with sensor markers inside a ${area}-acre site boundary`}
        >
          <defs>
            <pattern
              id="site-grid"
              width="36"
              height="36"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 36 0 L 0 0 0 36"
                fill="none"
                stroke="#28353b"
                strokeWidth="1"
              />
            </pattern>
            <pattern
              id="ground-texture"
              width="14"
              height="14"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="3" r="1" fill="#62724e" opacity=".22" />
              <circle cx="10" cy="9" r="1" fill="#87926a" opacity=".18" />
            </pattern>
            <filter
              id="sensor-glow"
              x="-80%"
              y="-80%"
              width="260%"
              height="260%"
            >
              <feGaussianBlur stdDeviation="7" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect width="1100" height="700" fill="#182329" />
          <rect
            width="1100"
            height="700"
            fill="url(#site-grid)"
            opacity=".55"
          />
          <g
            transform={`translate(${550 - (siteWidth * scale) / 2},${350 - (siteHeight * scale) / 2}) scale(${scale})`}
          >
            <rect
              x="0"
              y="0"
              width={siteWidth}
              height={siteHeight}
              rx="8"
              className="site-boundary-fill"
            />
            <rect
              x="0"
              y="0"
              width={siteWidth}
              height={siteHeight}
              rx="8"
              fill="url(#ground-texture)"
            />
            <rect
              x="0"
              y="0"
              width={siteWidth}
              height={siteHeight}
              rx="8"
              className="site-boundary"
            />
            <g
              transform={`translate(${facilityOffsetX},${facilityOffsetY}) scale(${facilityScale})`}
            >
              <path
                d="M70 226 H710 M130 120 H410 M410 120 V356 M650 120 V356"
                className="road"
              />
              <path
                d="M190 220 L190 130 L320 130 L320 220 M425 226 L425 148 L610 148 M425 228 L640 228 L640 337 M210 228 L210 328 L372 328"
                className="pipe-line"
              />
              <g
                className="map-structure"
                opacity={feedMode === "backend" ? 0.15 : 1}
              >
                <rect x="286" y="184" width="96" height="78" rx="4" />
                <path d="M334 184 V148 M309 148 H359 M317 262 V277 M350 262 V277" />
                <text x="334" y="238" textAnchor="middle">
                  WELL DECK
                </text>
                <path
                  d="M328 144 L334 128 L340 144 M326 136 H342"
                  className="derrick"
                />
              </g>
              <g className="map-structure">
                <rect x="425" y="112" width="142" height="62" rx="4" />
                <path d="M444 124 H548 M444 136 H548 M444 148 H520" />
                <text x="496" y="164" textAnchor="middle">
                  SEPARATOR
                </text>
              </g>
              <g className="map-structure">
                <rect x="426" y="259" width="138" height="79" rx="4" />
                <circle cx="462" cy="295" r="17" />
                <circle cx="519" cy="295" r="17" />
                <path d="M451 295 H473 M508 295 H530" />
                <text x="495" y="329" textAnchor="middle">
                  PUMP HOUSE
                </text>
              </g>
              <g className="map-structure">
                <rect x="595" y="256" width="99" height="80" rx="4" />
                <circle cx="622" cy="283" r="18" />
                <circle cx="665" cy="283" r="18" />
                <text x="645" y="323" textAnchor="middle">
                  TANK FARM
                </text>
              </g>
              <g className="map-structure">
                <rect x="108" y="106" width="122" height="58" rx="4" />
                <path d="M126 124 H210 M126 137 H185" />
                <text x="169" y="155" textAnchor="middle">
                  CONTROL ROOM
                </text>
              </g>
              <g className="map-structure">
                <rect x="101" y="289" width="122" height="57" rx="4" />
                <path d="M119 310 H204 M119 322 H186" />
                <text x="162" y="337" textAnchor="middle">
                  POWER HOUSE
                </text>
              </g>
              <rect
                x="0"
                y="196"
                width="45"
                height="60"
                rx="3"
                className="gate-house"
              />
              <path d="M16 226 H52 M26 212 V240" className="gate-mark" />
              <text x="8" y="269" className="map-label">
                SITE GATE
              </text>
              <text x="14" y="24" className="map-label">
                NORTH PERIMETER
              </text>
              <text x="646" y="446" className="map-label">
                SOUTH ACCESS ROAD
              </text>
              <g className="north-marker">
                <path d="M745 46 V16 M735 26 L745 16 L755 26" />
                <text x="745" y="62" textAnchor="middle">
                  N
                </text>
              </g>
              <g className="scale-marker">
                <path d="M26 421 V430 H142 V421" />
                <text x="84" y="449" textAnchor="middle">
                  {Math.round(250 * areaScale)} m
                </text>
              </g>
            </g>
            {shownSensors.map((sensor) => {
              const isSelected = selectedSensorId === sensor.id;
              return (
                <g
                  key={sensor.id}
                  className={`sensor-hit ${severityState(sensor)} ${isSelected ? "selected" : ""}`}
                  transform={`translate(${(sensor.x / 100) * siteWidth},${(sensor.y / 100) * siteHeight})`}
                  role="button"
                  tabIndex="0"
                  aria-label={`${sensor.name}, ${severityState(sensor)}, ${sensor.value}`}
                  aria-pressed={isSelected}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectSensor(sensor.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectSensor(sensor.id);
                    }
                  }}
                >
                  <circle r={sensorHitRadius} className="sensor-touch-target" />
                  <circle r="18" className="sensor-ring" />
                  <circle r="23" className="sensor-pulse" />
                  {sensor.timeToActSeconds && !acknowledged[sensor.id] && (
                    <circle
                      r="27"
                      className={`site-urgency-ring ${remainingSeconds(sensor, now) / sensor.timeToActSeconds < 0.2 ? "critical" : ""}`}
                      strokeDasharray={2 * Math.PI * 27}
                      strokeDashoffset={
                        2 *
                        Math.PI *
                        27 *
                        (1 -
                          Math.max(
                            0,
                            remainingSeconds(sensor, now) /
                              sensor.timeToActSeconds,
                          ))
                      }
                    />
                  )}
                  <circle r="11" className="sensor-core" />
                  {severityState(sensor) === "alarm" ? (
                    <>
                      <path
                        d="M-5 3V0a5 5 0 0 1 10 0v3M-7 3h14M-5 6h10M-8 -8l-3 -3M8 -8l3 -3M0 -10v-4"
                        className="map-siren"
                      />
                    </>
                  ) : (
                    <text y="5" textAnchor="middle" className="sensor-glyph">
                      !
                    </text>
                  )}
                  <text
                    y="38"
                    textAnchor="middle"
                    className="sensor-name-label"
                  >
                    {sensor.name.split("·")[0].trim()}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="plan-corner plan-scale-summary">
          <b>{feedMode === "backend" ? "FIELD NETWORK" : area + " ACRES"}</b>
          <span>
            {feedMode === "backend"
              ? "Schematic · coordinates normalized to view"
              : "Site boundary · selectable sample size"}
          </span>
        </div>
        <div className="plan-corner plan-feed-summary">
          <span className="sample-led" /> SENSOR FEED:{" "}
          {feedMode === "backend"
            ? (appState.backend?.view?.state?.mode ?? "CONNECTING")
            : feedMode === "live"
              ? "LIVE SIMULATION"
              : "SIMULATED"}
        </div>
        <div className="plan-legend">
          <span>
            <i className="legend-dot alarm" /> URGENT
          </span>
          <span>
            <i className="legend-dot warning" /> CHECK
          </span>
          <span>
            <i className="legend-dot normal" /> NORMAL
          </span>
        </div>
      </div>
      <div className="map-bottomline">
        <span>
          Tap any sensor to see its reading and recommended next step.
        </span>
        <span>Not a live control or emergency system</span>
      </div>
    </section>
  );
}

function AlertPanel() {
  const {
    selectedSensorId,
    acknowledged,
    notice,
    lastCheck,
    now,
    sensors: siteSensors,
  } = useAppState();
  const sensor = siteSensors.find((item) => item.id === selectedSensorId);
  if (!sensor) {
    return (
      <section className="side-panel alert-panel">
        <div className="panel-title-row alert-panel-heading">
          <div>
            <div className="eyebrow">WHAT NEEDS ATTENTION</div>
            <h2>Site alert</h2>
          </div>
          <span className="checked-time">CHECKED {formatTime(lastCheck)}</span>
        </div>
        <div className="empty-note">
          No alerts yet. New alerts will appear here when generated.
        </div>
        {notice && (
          <div className="action-notice" role="status">
            {notice}
          </div>
        )}
      </section>
    );
  }
  const state = severityState(sensor);
  const hasAlert =
    state === "alarm" || state === "warning" || state === "watch";
  const isAcknowledged = Boolean(acknowledged[sensor.id]);
  const severity = severityFor(sensor);
  return (
    <section className="side-panel alert-panel">
      <div className="panel-title-row alert-panel-heading">
        <div>
          <div className="eyebrow">WHAT NEEDS ATTENTION</div>
          <h2>{hasAlert ? "Site alert" : "Site status"}</h2>
        </div>
        <span className="checked-time">CHECKED {formatTime(lastCheck)}</span>
      </div>
      <div className={`alert-card ${severity}`}>
        <div className="alert-card-top">
          <span className={`severity-chip ${severity}`}>
            <SeveritySymbol severity={severity} />
            {hasAlert
              ? state === "alarm"
                ? "URGENT"
                : state === "warning"
                  ? "CHECK SOON"
                  : "KEEP AN EYE ON"
              : "NORMAL"}
          </span>
          {isAcknowledged && (
            <span className="acknowledged-label">ACKNOWLEDGED</span>
          )}
        </div>
        <h3>{sensor.message}</h3>
        <div className="alert-reading">
          <span>{sensor.name}</span>
          <b>{sensor.value}</b>
        </div>
        {sensor.operations && (
          <div className="operations-affected">
            <span>OPERATIONS AFFECTED</span>
            <b>{sensor.operations}</b>
          </div>
        )}
        {hasAlert && (
          <div className="next-step">
            <span className="next-step-label">SUGGESTED NEXT STEP</span>
            <p>{sensor.advice}</p>
          </div>
        )}
        {sensor.actions && (
          <div className="potential-actions">
            <div className="potential-actions-heading">
              <span>POTENTIAL RESPONSES</span>
              <small>ESTIMATED COST · USD</small>
            </div>
            {sensor.actions.map((action) => (
              <button
                key={action.name}
                className="potential-action"
                onClick={() =>
                  sensor.backend
                    ? backendActions
                        .record(action.systemId)
                        .then(() =>
                          recordAction(
                            "Current system plan recorded in the backend audit log.",
                          ),
                        )
                        .catch((e) => recordAction(e.message, "warning"))
                    : recordAction(
                        `${action.name} selected for review. Estimated sample cost: ${formatMoney(actionCost(sensor, action, now))}. No equipment action was taken.`,
                        severity,
                      )
                }
              >
                <span>
                  {action.name}
                  <small>Selection only · no equipment control</small>
                </span>
                <b>{formatMoney(actionCost(sensor, action, now))}</b>
              </button>
            ))}
            {sensor.costGrowthPerSecond > 0 && (
              <div className="cost-growth-note">
                Sample delay estimate increases by{" "}
                {formatMoneyRate(sensor.costGrowthPerSecond)}.
              </div>
            )}
          </div>
        )}
        <div className="alert-actions">
          {hasAlert && (
            <Button
              className="primary-touch-button"
              onClick={() => acknowledge(sensor)}
              disabled={isAcknowledged}
            >
              {isAcknowledged ? "ACKNOWLEDGED" : "ACKNOWLEDGE ALERT"}
            </Button>
          )}
          <Button
            className="secondary-touch-button"
            onClick={() =>
              recordAction(`${sensor.name} selected on the site plan.`)
            }
          >
            SHOW ON PLAN
          </Button>
        </div>
      </div>
      {sensor.backend && (
        <div className="backend-evidence">
          <UrgencyTimer sensor={sensor} now={now} />
          <p>
            {sensor.etaState}: {sensor.etaReason}
          </p>
          <b>ML: {sensor.ml?.label ?? sensor.ml?.state ?? "unavailable"}</b>
          <p>{sensor.ml?.reason}</p>
          {sensor.ml?.evidence?.map((e) => (
            <small key={e.feature}>
              {e.feature}: {Number(e.value).toFixed(4)} · contribution{" "}
              {Number(e.contribution).toFixed(3)}
              <br />
            </small>
          ))}
        </div>
      )}
      <div className="acknowledge-note">
        Acknowledgment records review only; it does not clear the condition,
        stop the forecast, or restart production.
      </div>
      {notice && (
        <div className="action-notice" role="status">
          {notice}
        </div>
      )}
    </section>
  );
}

function ActivityPanel() {
  const { activity, feedMode } = useAppState();
  return (
    <section className="side-panel activity-panel">
      <div className="panel-title-row">
        <div>
          <div className="eyebrow">RECENT CHANGES</div>
          <h2>Site log</h2>
        </div>
        <span className={`live-label ${feedMode}`}>
          <i /> {feedMode === "live" ? "LIVE SIM" : "SIMULATED"}
        </span>
      </div>
      <div className="event-list">
        {activity.slice(0, 4).map((event, index) => (
          <button
            className="event-row"
            key={`${event.time}-${index}`}
            onClick={() =>
              recordAction(`${formatTime(event.time)} · ${event.text}`)
            }
          >
            <span className={`event-marker ${event.tone}`} />
            <span className="event-copy">
              <b>{event.text}</b>
              <small>{formatTime(event.time)}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CustomAlertForm({ onClose, onSave }) {
  const [values, setValues] = useState({
    name: "",
    kind: "",
    area: "",
    value: "",
    state: "alarm",
    advice: "",
    timeToActSeconds: "300",
    costGrowthPerSecond: "0",
  });
  const [actions, setActions] = useState([{ id: 1, name: "", cost: "" }]);
  const [nextActionId, setNextActionId] = useState(2);
  const [error, setError] = useState("");

  function updateField(event) {
    setValues((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  }

  function updateAction(id, field, value) {
    setActions((current) =>
      current.map((action) =>
        action.id === id ? { ...action, [field]: value } : action,
      ),
    );
  }

  function submit(event) {
    event.preventDefault();
    const solutions = actions
      .map((action) => ({
        name: action.name.trim(),
        cost: action.cost.trim(),
        baseCost: Number(action.cost),
      }))
      .filter((action) => action.name);
    if (!solutions.length) {
      setError("Add at least one potential solution with a name.");
      return;
    }
    if (
      solutions.some(
        (action) =>
          !action.cost ||
          !Number.isFinite(action.baseCost) ||
          action.baseCost < 0,
      )
    ) {
      setError("Enter a valid zero-or-higher cost for each solution.");
      return;
    }
    onSave({
      name: values.name.trim(),
      kind: values.kind.trim(),
      area: values.area.trim(),
      value: values.value.trim(),
      severityLevel: severityLevelFromState(values.state),
      message: `${values.kind.trim()} alert at ${values.area.trim()}.`,
      advice: values.advice.trim(),
      timeToActSeconds: Number(values.timeToActSeconds),
      costGrowthPerSecond: Number(values.costGrowthPerSecond),
      actions: solutions.map(({ name, baseCost }) => ({ name, baseCost })),
    });
  }

  return (
    <div
      className="custom-alert-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-alert-title"
    >
      <form className="custom-alert-form" onSubmit={submit}>
        <div className="custom-alert-form-heading">
          <div>
            <div className="eyebrow">LIVE SIMULATION</div>
            <h2 id="custom-alert-title">Create a custom alert</h2>
          </div>
          <button
            type="button"
            className="custom-alert-close"
            onClick={onClose}
            aria-label="Close alert form"
          >
            ×
          </button>
        </div>
        <div className="custom-alert-fields">
          <label>
            Alert name
            <input
              name="name"
              value={values.name}
              onChange={updateField}
              required
              maxLength={80}
            />
          </label>
          <label>
            Issue type
            <input
              name="kind"
              value={values.kind}
              onChange={updateField}
              required
              maxLength={60}
            />
          </label>
          <label>
            Location
            <input
              name="area"
              value={values.area}
              onChange={updateField}
              required
              maxLength={60}
            />
          </label>
          <label>
            Reading or value
            <input
              name="value"
              value={values.value}
              onChange={updateField}
              required
              maxLength={40}
            />
          </label>
          <label>
            Alert color
            <select name="state" value={values.state} onChange={updateField}>
              <option value="alarm">Red · emergency</option>
              <option value="warning">Yellow · attention</option>
              <option value="normal">Green · normal</option>
            </select>
          </label>
          <label>
            Recommended time to act (seconds)
            <input
              name="timeToActSeconds"
              type="number"
              min="1"
              step="1"
              value={values.timeToActSeconds}
              onChange={updateField}
              required
            />
          </label>
          <label>
            Cost growth ($ per second)
            <input
              name="costGrowthPerSecond"
              type="number"
              min="0"
              step="0.01"
              value={values.costGrowthPerSecond}
              onChange={updateField}
              required
            />
          </label>
          <label className="custom-alert-wide">
            Suggested next step
            <textarea
              name="advice"
              value={values.advice}
              onChange={updateField}
              maxLength={300}
              rows="2"
            />
          </label>
        </div>
        <div className="custom-solutions">
          <div className="custom-solutions-heading">
            <b>Potential solutions</b>
            <button
              type="button"
              className="add-solution-button"
              onClick={() => {
                setActions((current) => [
                  ...current,
                  { id: nextActionId, name: "", cost: "" },
                ]);
                setNextActionId((id) => id + 1);
              }}
            >
              + ADD SOLUTION
            </button>
          </div>
          {actions.map((action, index) => (
            <div className="custom-solution-row" key={action.id}>
              <label>
                Solution {index + 1}
                <input
                  value={action.name}
                  onChange={(event) =>
                    updateAction(action.id, "name", event.target.value)
                  }
                  maxLength={100}
                />
              </label>
              <label>
                Estimated cost ($)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={action.cost}
                  onChange={(event) =>
                    updateAction(action.id, "cost", event.target.value)
                  }
                />
              </label>
              <button
                type="button"
                className="remove-solution-button"
                onClick={() =>
                  setActions((current) =>
                    current.filter((item) => item.id !== action.id),
                  )
                }
                disabled={actions.length === 1}
                aria-label={`Remove solution ${index + 1}`}
              >
                REMOVE
              </button>
            </div>
          ))}
        </div>
        {error && (
          <div className="custom-alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="custom-alert-form-footer">
          <span>Demo alert only · no equipment control</span>
          <div>
            <button
              type="button"
              className="secondary-touch-button"
              onClick={onClose}
            >
              CANCEL
            </button>
            <button type="submit" className="create-alert-submit">
              CREATE ALERT
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function EmergencyCard({ sensor, now, rank, activeCount }) {
  const remaining = remainingSeconds(sensor, now);
  return (
    <article
      className="emergency-card"
      aria-labelledby={`emergency-${sensor.id}`}
    >
      <div className="emergency-card-header">
        <div className="emergency-priority">
          <SeveritySymbol severity="alarm" />
          <span>
            <b>RED ALERT · EMERGENCY</b>
            <small>
              PRIORITY {rank} OF {activeCount}
              {sensor.costGrowthPerSecond > 0
                ? ` · COST GROWTH ${formatMoneyRate(sensor.costGrowthPerSecond)}`
                : ""}
            </small>
          </span>
        </div>
        <UrgencyTimer sensor={sensor} now={now} />
      </div>
      <h2 id={`emergency-${sensor.id}`}>{sensor.name}</h2>
      <p className="emergency-message">{sensor.message}</p>
      {sensor.operations && (
        <div className="emergency-operations">
          <span>OPERATIONS AFFECTED</span>
          <b>{sensor.operations}</b>
        </div>
      )}
      {sensor.advice && (
        <div className="emergency-next-step">
          <span>FIRST: FOLLOW YOUR SITE EMERGENCY PLAN</span>
          <p>{sensor.advice}</p>
        </div>
      )}
      <div className="emergency-actions-heading">
        <span>POTENTIAL RESPONSES</span>
        <small>ESTIMATED COST · USD</small>
      </div>
      <div className="emergency-action-list">
        {sensor.actions.map((action) => (
          <button
            key={action.name}
            className="emergency-action"
            onClick={() =>
              recordAction(
                `${action.name} selected for review. Current sample estimate: ${formatMoney(actionCost(sensor, action, now))}. No equipment action was taken.`,
                "alarm",
              )
            }
          >
            <span>
              {action.name}
              <small>SELECT TO RECORD FOR REVIEW · NO EQUIPMENT CONTROL</small>
            </span>
            <b>{formatMoney(actionCost(sensor, action, now))}</b>
          </button>
        ))}
      </div>
      <div className="emergency-card-footer">
        <span>ESTIMATE ONLY · NOT A REAL COST OR SAFETY DEADLINE</span>
        <div className="emergency-footer-actions">
          <Button
            className="dismiss-emergency-button"
            onClick={() => acknowledge(sensor)}
          >
            ACKNOWLEDGE ALERT
          </Button>
          <Button
            className="dismiss-emergency-button secondary-dismiss"
            onClick={() => dismissEmergency(sensor)}
          >
            VIEW IN ALERT PANEL
          </Button>
        </div>
      </div>
    </article>
  );
}

function EmergencyOverlay() {
  const { acknowledged, dismissedEmergencies, now } = useAppState();
  const emergencies = activeEmergencies(acknowledged);
  if (appState.feedMode === "backend" || !emergencies.length) return null;
  const visibleEmergencies = emergencies
    .filter((sensor) => !dismissedEmergencies[sensor.id])
    .slice(0, 4);
  if (!visibleEmergencies.length) return null;
  return (
    <div
      className={`emergency-overlay ${visibleEmergencies.length === 1 ? "single-emergency" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Active emergency alerts"
    >
      <div className="emergency-overlay-heading">
        <div className="emergency-overlay-title">
          <SeveritySymbol severity="alarm" />
          <span>
            <b>EMERGENCY ALERT</b>
            <small>
              {emergencies.length} ACTIVE · ACKNOWLEDGE IN THE ALERT PANEL TO
              COMPLETE
            </small>
          </span>
        </div>
        <div className="emergency-overlay-counter">
          {visibleEmergencies.length} OF {emergencies.length} SHOWN
        </div>
      </div>
      {emergencies.length > 4 && (
        <div className="emergency-overflow-note">
          Additional emergencies remain in the sensor and alert panels. Highest
          cost-per-second items are shown first.
        </div>
      )}
      <div className="emergency-grid">
        {visibleEmergencies.map((sensor) => (
          <EmergencyCard
            key={sensor.id}
            sensor={sensor}
            now={now}
            rank={emergencies.indexOf(sensor) + 1}
            activeCount={emergencies.length}
          />
        ))}
      </div>
    </div>
  );
}

function EmergencySoundListener() {
  const {
    acknowledged,
    dismissedEmergencies,
    soundPermission,
    sensors: siteSensors,
  } = useAppState();
  const previouslyActiveIds = useRef(
    new Set(activeEmergencies().map((sensor) => sensor.id)),
  );
  useEffect(() => {
    const active = activeEmergencies(acknowledged);
    const newlyActive = active.filter(
      (sensor) => !previouslyActiveIds.current.has(sensor.id),
    );
    if (
      soundPermission === "allowed" &&
      newlyActive.some(
        (sensor) => !sensor.generated && !dismissedEmergencies[sensor.id],
      )
    ) {
      playEmergencySiren();
    }
    previouslyActiveIds.current = new Set(active.map((sensor) => sensor.id));
  }, [acknowledged, dismissedEmergencies, soundPermission, siteSensors]);
  return null;
}

function Workspace() {
  const layoutHost = useRef(null);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const updateLayoutMode = () => setCompact(mediaQuery.matches);
    mediaQuery.addEventListener("change", updateLayoutMode);
    return () => mediaQuery.removeEventListener("change", updateLayoutMode);
  }, []);

  useEffect(() => {
    const layout = new GoldenLayout(layoutHost.current);
    layout.resizeWithContainerAutomatically = true;
    const factories = {
      site: (container) => mountComponent(container, <SiteMap />),
      alerts: (container) => mountComponent(container, <AlertPanel />),
      activity: (container) => mountComponent(container, <ActivityPanel />),
      operations: (container) => mountComponent(container, <BackendPanel />),
    };
    Object.entries(factories).forEach(([name, factory]) =>
      layout.registerComponentFactoryFunction(name, factory),
    );
    const root = compact
      ? {
          type: "column",
          content: [
            {
              type: "component",
              componentType: "site",
              title: "RIG SITE PLAN",
              height: 55,
              isClosable: false,
            },
            {
              type: "stack",
              height: 45,
              content: [
                {
                  type: "component",
                  componentType: "operations",
                  title: "DECISIONS & ML",
                  isClosable: false,
                },
                {
                  type: "component",
                  componentType: "alerts",
                  title: "SITE ALERT",
                  isClosable: false,
                },
                {
                  type: "component",
                  componentType: "activity",
                  title: "SITE LOG",
                  isClosable: false,
                },
              ],
            },
          ],
        }
      : {
          type: "row",
          content: [
            {
              type: "component",
              componentType: "site",
              title: "RIG SITE PLAN",
              width: 68,
              isClosable: false,
            },
            {
              type: "column",
              width: 32,
              content: [
                {
                  type: "component",
                  componentType: "operations",
                  title: "DECISIONS & ML",
                  height: 55,
                  isClosable: false,
                },
                {
                  type: "stack",
                  height: 45,
                  content: [
                    {
                      type: "component",
                      componentType: "alerts",
                      title: "SITE ALERT",
                      isClosable: false,
                    },
                    {
                      type: "component",
                      componentType: "activity",
                      title: "SITE LOG",
                      isClosable: false,
                    },
                  ],
                },
              ],
            },
          ],
        };
    layout.loadLayout({ root });
    return () => layout.destroy();
  }, [compact]);
  return (
    <main className="workspace">
      <div ref={layoutHost} className="layout-host" />
    </main>
  );
}

function mountComponent(container, component) {
  const host = document.createElement("div");
  host.className = "golden-panel-host";
  container.element.appendChild(host);
  const root = createRoot(host);
  root.render(component);
  container.on("destroy", () => queueMicrotask(() => root.unmount()));
}

function Footer() {
  const { feedMode } = useAppState();
  return (
    <footer className="footerbar">
      <div className="footer-left">
        <span className="footer-sim-dot" />{" "}
        {feedMode === "backend"
          ? "BACKEND TELEMETRY · SIMULATED FIELD"
          : feedMode === "live"
            ? "LIVE SIMULATION"
            : "SIMULATED TRAINING DATA"}{" "}
        <span className="footer-sep">·</span> NOT CONNECTED TO RIG EQUIPMENT
      </div>
      <span className="footer-disclaimer">
        {feedMode === "backend"
          ? "Backend observations · simulated decisions"
          : "Sample environment only"}
      </span>
    </footer>
  );
}

function App() {
  const liveState = useAppState();
  const selected = liveState.sensors.find(
    (s) => s.id === liveState.selectedSensorId,
  );
  const [ripple, setRipple] = useState(null);
  const rippleTimer = useRef(null);
  useEffect(() => {
    void startBackend();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      updateState({ now: Date.now() });
      if (
        appState.feedMode === "simulated" &&
        appState.autoGenerateAlerts &&
        Math.random() < 0.08
      )
        addRandomAlert();
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => window.clearTimeout(rippleTimer.current), []);
  function showClickFeedback(event) {
    setRipple({ x: event.clientX, y: event.clientY, key: Date.now() });
    window.clearTimeout(rippleTimer.current);
    rippleTimer.current = window.setTimeout(() => setRipple(null), 650);
  }
  return (
    <div
      className={`${Classes.DARK} app-shell`}
      onPointerDown={showClickFeedback}
    >
      <Header />
      {appState.feedMode === "backend" && (
        <div
          className={`backend-banner ${!appState.backend?.connected || appState.backend?.view?.field?.tripped ? "attention" : ""}`}
          role="status"
        >
          {appState.backend?.connected
            ? appState.backend?.view?.field?.tripped
              ? "COMPLETE SIMULATED FIELD SHUTDOWN · All modeled production off; sensors remain monitored"
              : `BACKEND CONNECTED · ${appState.backend.view?.state?.mode ?? "loading"} / ${appState.backend.view?.state?.status ?? "loading"}`
            : "BACKEND DISCONNECTED · Forecasts and actions withheld"}{" "}
          · SIMULATION ONLY — NO EQUIPMENT COMMANDS
        </div>
      )}
      {liveState.feedMode === "backend" && selected && (
        <div className="backend-forecast-strip" data-testid="selected-forecast">
          <span>
            {selected.name} · {selected.value}
          </span>
          <b>
            {selected.etaState === "field_shutdown"
              ? "FIELD SHUT DOWN"
              : selected.timeToActSeconds === null ||
                  selected.timeToActSeconds === undefined
                ? "ETA unavailable — " + selected.etaState
                : selected.timeToActSeconds === 0
                  ? "SHUTDOWN THRESHOLD REACHED"
                  : formatDuration(selected.timeToActSeconds) +
                    " until shutdown"}
          </b>
          <small>{selected.etaBasis}</small>
        </div>
      )}
      <Workspace />
      <Footer />
      <EmergencySoundListener />
      <EmergencyOverlay />
      {ripple && (
        <span
          key={ripple.key}
          className="click-feedback"
          style={{ left: ripple.x, top: ripple.y }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

const appRoot =
  globalThis.__oilerAppRoot || createRoot(document.getElementById("root"));
globalThis.__oilerAppRoot = appRoot;
appRoot.render(<App />);
