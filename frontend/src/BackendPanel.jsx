import React, { useState, useEffect, useSyncExternalStore } from "react";
import {
  backendActions,
  getBackendState,
  subscribeBackend,
} from "./backend.js";
import { readJson } from "./backendAdapter.js";
const money = (value) =>
  value === null || value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
const duration = (hours) =>
  hours === undefined || hours === null
    ? "No reliable ETA"
    : hours === 0
      ? "Threshold reached"
      : `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
export function BackendPanel() {
  const backend = useSyncExternalStore(subscribeBackend, getBackendState),
    { view, connected, writer, busy } = backend;
  const [error, setError] = useState(""),
    [hours, setHours] = useState("6"),
    [opex, setOpex] = useState("0");
  const field = readJson(view?.field),
    d = field.decision,
    ready = connected && view?.state?.status === "ready";
  useEffect(() => {
    if (field.policy) {
      setHours(String(field.policy.horizonHours));
      setOpex(String(field.policy.avoidableOperatingCostPerHour));
    }
  }, [
    view?.state?.session,
    field.policy?.horizonHours,
    field.policy?.avoidableOperatingCostPerHour,
  ]);
  async function run(fn) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <section className="backend-panel" aria-label="Backend decisions">
      <div className="eyebrow">
        SPACETIMEDB · {connected ? "CONNECTED" : "DISCONNECTED"} ·{" "}
        {writer ? "LOCAL DEMO WRITER" : "READ ONLY"}
      </div>
      <h2>Operations intelligence</h2>
      <p className="backend-source">
        Source: {view?.state?.mode ?? "waiting"} ·{" "}
        {view?.state?.status ?? "unavailable"}
        <br />
        Field time:{" "}
        {view?.state?.modelTs
          ? new Date(view.state.modelTs * 1000).toISOString()
          : "—"}
      </p>
      <div className="backend-controls">
        <button
          disabled={busy || !writer}
          onClick={() => run(() => backendActions.source("snapshot"))}
        >
          Load snapshot
        </button>
        <button
          disabled={busy || !writer}
          onClick={() => run(() => backendActions.source("mock"))}
        >
          Start water mock
        </button>
        <button
          disabled={busy || !writer}
          onClick={() => run(() => backendActions.source("stop_mock"))}
        >
          Stop mock
        </button>
        <button
          disabled={busy || !writer}
          onClick={() => run(() => backendActions.source("all_at_risk"))}
        >
          Demo: all at risk
        </button>
        {!connected && (
          <button onClick={() => run(backendActions.reconnect)}>
            Reconnect
          </button>
        )}
      </div>
      <small>
        Source controls start a new simulation session. “Stop mock” lets
        stale-data handling run.
      </small>
      <div
        className={`field-decision ${view?.field?.tripped ? "tripped" : ""}`}
        data-testid="field-state"
      >
        <b>
          {view?.field?.tripped
            ? "COMPLETE SIMULATED FIELD SHUTDOWN"
            : "FIELD PRODUCTION MONITORED"}
        </b>
        <p>
          {view?.field?.tripped
            ? (field.latched?.decision?.explanation ?? view.field.reason)
            : (d?.explanation ?? "Waiting for a complete source frame.")}
        </p>
        <span>
          {view?.wellProduction?.filter(
            (w) => w.deliveredOilBpd === 0 && w.deliveredGasMcfd === 0,
          ).length ?? 0}
          /{view?.wellProduction?.length ?? 0} wells with zero modeled
          production
        </span>
        {view?.field?.tripped && (
          <button
            disabled={!ready || !writer || busy}
            onClick={() => run(backendActions.reset)}
          >
            Review conditions and restart simulation
          </button>
        )}
      </div>
      {d && (
        <>
          <h3>Field strategy comparison · {d.horizonHours}h</h3>
          <small>
            Incremental cost versus current producing wells.{" "}
            {d.state === "comparison_incomplete"
              ? "Comparison incomplete; economic trigger withheld."
              : ""}
          </small>
          <table className="backend-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Modeled cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Selective response</td>
                <td>
                  {ready && d.state === "ready"
                    ? money(d.selective.totalCost)
                    : "Unavailable"}
                </td>
              </tr>
              <tr>
                <td>Accept shutdowns</td>
                <td>
                  {ready && d.state === "ready"
                    ? money(d.acceptShutdowns.totalCost)
                    : "Unavailable"}
                </td>
              </tr>
              <tr>
                <td>Immediate full-field stop</td>
                <td>
                  {ready ? money(d.fullShutdown.totalCost) : "Unavailable"}
                </td>
              </tr>
            </tbody>
          </table>
          <small>{d.assumptions}</small>
        </>
      )}
      <div className="backend-policy">
        <label>
          Horizon (hours)
          <input
            aria-label="Horizon hours"
            type="number"
            min="0.1"
            max="168"
            step=".5"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <label>
          Avoidable operating cost ($/hour)
          <input
            aria-label="Avoidable operating cost"
            type="number"
            min="0"
            value={opex}
            onChange={(e) => setOpex(e.target.value)}
          />
        </label>
        <button
          disabled={!ready || !writer || busy}
          onClick={() =>
            run(() =>
              backendActions.policy({
                ...field.policy,
                horizonHours: Number(hours),
                avoidableOperatingCostPerHour: Number(opex),
              }),
            )
          }
        >
          Apply demo assumptions
        </button>
        <small>
          Operating cost is an explicit demo assumption, absent from the
          challenge files; default $0. The configured rule may latch a simulated
          shutdown.
        </small>
      </div>
      <h3>Warning → shutdown forecast</h3>
      {view?.warningForecasts?.length ? (
        <table className="backend-table">
          <thead>
            <tr>
              <th>Tank</th>
              <th>No-action estimate</th>
            </tr>
          </thead>
          <tbody>
            {view.warningForecasts.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>
                  {ready ? duration(p.hoursToShutdown) : "Unavailable"}
                  <small>{p.state}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No field tank warning is active.</p>
      )}
      {view?.hardwarePredictions?.map((p) => (
        <p key={p.id}>
          <b>Tabletop ETA:</b>{" "}
          {ready && p.secondsToThreshold !== undefined
            ? `${Math.ceil(p.secondsToThreshold)} seconds`
            : p.state}{" "}
          · physical sensor time
        </p>
      ))}
      <h3>System response plans</h3>
      <table className="backend-table">
        <thead>
          <tr>
            <th>System / action</th>
            <th>Cost / savings</th>
          </tr>
        </thead>
        <tbody>
          {view?.recommendations?.map((r) => {
            const detail = readJson(r);
            return (
              <tr key={r.id}>
                <td>
                  {r.id} · {r.status}
                  <small>
                    {detail.result?.plans
                      ?.map((p) => `${p.facilityId}: ${p.kind}`)
                      .join(" · ")}
                  </small>
                </td>
                <td>
                  {ready ? money(r.totalCost) : "Unavailable"}
                  <small>{ready ? `${money(r.savings)} saved` : ""}</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>ML inspection evidence</h3>
      <small>
        Class scores, not equipment failure probabilities. Missing or ambiguous
        evidence is withheld.
      </small>
      <table className="backend-table">
        <thead>
          <tr>
            <th>Facility</th>
            <th>Model label / score</th>
          </tr>
        </thead>
        <tbody>
          {view?.ml
            ?.filter((r) => r.label !== "normal")
            .map((r) => {
              const m = readJson(r);
              return (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>
                    {r.label ?? r.state}
                    <small>
                      {m.topScore !== null && m.topScore !== undefined
                        ? `Score ${m.topScore > 0.9999 ? ">99.99" : (m.topScore * 100).toFixed(2)}%`
                        : m.reason}
                    </small>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {(error || backend.error) && (
        <p role="alert" className="backend-error">
          {error || backend.error}
        </p>
      )}
    </section>
  );
}
