import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import Avatar from "../components/Avatar";
import { IconCamera, IconClock, IconLogout, IconMonitor, IconPin } from "../components/Icons";
import { fmtDuration, fmtTime, hhmm, WEEKDAYS } from "../format";
import { Tracker, type TrackerStatus } from "../tracker";
import type { MyStats, TrackingConfig } from "../types";

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function UserHome() {
  const { user, logout } = useAuth();
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [config, setConfig] = useState<TrackingConfig | null>(null);
  const [stats, setStats] = useState<MyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const trackerRef = useRef<Tracker | null>(null);

  if (!trackerRef.current) trackerRef.current = new Tracker(setStatus);
  const tracker = trackerRef.current;
  const active = status?.active ?? false;

  const refresh = useCallback(() => {
    api<TrackingConfig>("/tracking/config").then(setConfig).catch(() => undefined);
    api<MyStats>("/tracking/me/stats").then(setStats).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [active, refresh]);

  // Live clock while working.
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (tracker.isActive) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tracker]);

  useEffect(() => () => void tracker.stop("manual"), [tracker]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await tracker.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    await tracker.stop("manual");
    setBusy(false);
  }

  async function signOut() {
    await tracker.stop("manual");
    logout();
  }

  const tz = config?.timezone;
  const canStart = !!config && config.tracking_enabled;

  return (
    <div>
      <header className="topbar">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark sm">
            <IconMonitor size={16} />
          </span>
          <span>WFH Tracker</span>
        </div>
        <div className="row gap">
          {user && <Avatar name={user.full_name} size={30} />}
          <span className="person-name small">{user?.full_name}</span>
          <button className="btn ghost icon" onClick={signOut} title="Sign out">
            <IconLogout />
          </button>
        </div>
      </header>

      <main className="user-main">
        <section className={`card hero ${active ? "on" : ""}`}>
          <div className="hero-ring">{active ? <span className="live-dot" /> : <IconClock size={26} />}</div>
          <div className="grow">
            {active && status?.startedAt ? (
              <>
                <div className="muted small" style={{ fontWeight: 500 }}>
                  Working — tracking is on
                </div>
                <div className="hero-clock">{clock(Date.now() - status.startedAt.getTime())}</div>
                <div className="hero-meta">
                  <span>
                    <IconClock size={14} /> started {fmtTime(status.startedAt.toISOString(), tz)}
                  </span>
                  {status.lastScreenshotAt && (
                    <span>
                      <IconCamera size={14} /> last screenshot {fmtTime(status.lastScreenshotAt.toISOString(), tz)}
                    </span>
                  )}
                  {status.lastLocationAt && (
                    <span>
                      <IconPin size={14} /> location {fmtTime(status.lastLocationAt.toISOString(), tz)}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2>Ready to start?</h2>
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  {config && !config.tracking_enabled
                    ? "Tracking is disabled for your account."
                    : (status?.message ?? "Click Start work when you begin your day.")}
                </p>
              </>
            )}
          </div>
          {active ? (
            <button className="btn danger lg" onClick={stop} disabled={busy}>
              Stop work
            </button>
          ) : (
            <button className="btn primary lg" onClick={start} disabled={busy || !canStart}>
              {busy ? "Starting…" : "Start work"}
            </button>
          )}
        </section>

        {error && <div className="alert error">{error}</div>}

        <div className="grid stats">
          <div className="card stat-card">
            <div className="stat-icon amber">
              <IconClock />
            </div>
            <div>
              <div className="stat-label">Today</div>
              <div className="stat-value">{stats ? fmtDuration(stats.seconds_today) : "–"}</div>
            </div>
          </div>
          <div className="card stat-card">
            <div className="stat-icon">
              <IconClock />
            </div>
            <div>
              <div className="stat-label">This week</div>
              <div className="stat-value">{stats ? fmtDuration(stats.seconds_this_week) : "–"}</div>
            </div>
          </div>
        </div>

        <div className="grid cols-2">
          <section className="card">
            <div className="card-head">
              <h3>Your schedule</h3>
              {config && <span className="faint small">{config.timezone}</span>}
            </div>
            {config && config.schedule.length === 0 && (
              <div className="card-body muted">No fixed schedule — you can work any time.</div>
            )}
            {config && config.schedule.length > 0 && (
              <table className="table compact">
                <tbody>
                  {config.schedule.map((w, i) => (
                    <tr key={i}>
                      <td>{WEEKDAYS[w.weekday]}</td>
                      <td className="mono">
                        {hhmm(w.start_time)} – {hhmm(w.end_time)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card notice">
            <div className="card-head">
              <h3>What is recorded while you work</h3>
            </div>
            <div className="card-body" style={{ paddingTop: 8 }}>
              <ul>
                <li>
                  A screenshot of your <strong>entire screen</strong> about every{" "}
                  {config?.screenshot_interval_minutes ?? "–"} minutes (exact times vary).
                </li>
                <li>Your approximate location about every {config?.location_interval_minutes ?? "–"} minutes.</li>
                <li>Start/stop times, and when this tab is hidden or shown.</li>
              </ul>
              <p className="muted small" style={{ margin: 0 }}>
                When you start, allow location and choose <strong>Entire screen</strong>. Keep this tab open (it can be
                minimized). Closing it or clicking "Stop sharing" ends your session.
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
