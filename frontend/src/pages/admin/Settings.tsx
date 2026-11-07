import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { keys } from "../../queryClient";
import type { AppSettings } from "../../types";

export default function SettingsPage() {
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: keys.settings,
    queryFn: () => api<AppSettings>("/admin/settings"),
    refetchOnWindowFocus: false, // don't overwrite a form being edited
  });
  const [s, setS] = useState<AppSettings | null>(settingsQ.data ?? null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Fill the form once data arrives (instantly from cache on revisits).
  useEffect(() => {
    if (settingsQ.data && !s) setS(settingsQ.data);
  }, [settingsQ.data, s]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<AppSettings>("/admin/settings", { method: "PATCH", body: s });
      qc.setQueryData(keys.settings, saved);
      qc.invalidateQueries({ queryKey: ["attendance"] }); // grace period affects late marking
      setS(saved);
      setMessage({ kind: "ok", text: "Saved. Running sessions pick up changes within a minute." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Defaults for everyone. Individual users can override the screenshot interval.</p>
        </div>
      </div>
      {!s ? (
        settingsQ.error ? (
          <div className="alert error">{settingsQ.error.message}</div>
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : (
        <form className="card" onSubmit={save} style={{ maxWidth: 760 }}>
          <div className="card-head">
            <h3>Capture</h3>
          </div>
          <div className="card-body stack">
            <div className="form-grid">
              <label className="field">
                Screenshot every
                <div className="row gap-sm">
                  <input
                    type="number"
                    min={1}
                    max={240}
                    className="narrow"
                    value={s.screenshot_interval_minutes}
                    onChange={(e) => setS({ ...s, screenshot_interval_minutes: Number(e.target.value) })}
                  />
                  <span className="muted">minutes</span>
                </div>
                <span className="hint">Default for all employees.</span>
              </label>
              <label className="field">
                Random variation
                <div className="row gap-sm">
                  <input
                    type="number"
                    min={0}
                    max={50}
                    className="narrow"
                    value={s.screenshot_jitter_percent}
                    onChange={(e) => setS({ ...s, screenshot_jitter_percent: Number(e.target.value) })}
                  />
                  <span className="muted">%</span>
                </div>
                <span className="hint">Shifts each capture by up to ± this much so timing can't be predicted.</span>
              </label>
              <label className="field">
                Location every
                <div className="row gap-sm">
                  <input
                    type="number"
                    min={1}
                    max={240}
                    className="narrow"
                    value={s.location_interval_minutes}
                    onChange={(e) => setS({ ...s, location_interval_minutes: Number(e.target.value) })}
                  />
                  <span className="muted">minutes</span>
                </div>
              </label>
            </div>
            <div className="form-section">
              <h3>Attendance</h3>
              <label className="field" style={{ marginTop: 12, maxWidth: 360 }}>
                Late after
                <div className="row gap-sm">
                  <input
                    type="number"
                    min={0}
                    max={240}
                    className="narrow"
                    value={s.late_grace_minutes}
                    onChange={(e) => setS({ ...s, late_grace_minutes: Number(e.target.value) })}
                  />
                  <span className="muted">minutes past the expected start</span>
                </div>
                <span className="hint">
                  Grace period. Starting within it counts as on time. Expected start comes from each user's working
                  hours.
                </span>
              </label>
            </div>
            <div className="form-section">
              <h3>Inactivity alerts</h3>
              <p className="muted small" style={{ margin: "4px 0 12px" }}>
                Notify admins (never the employee) when someone has no keyboard or mouse activity, or a locked screen,
                for too long while working. Alerts appear under Alerts in the sidebar.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.inactivity_alert_minutes > 0}
                  onChange={(e) => setS({ ...s, inactivity_alert_minutes: e.target.checked ? 10 : 0 })}
                />
                Alert admins about inactivity
              </label>
              {s.inactivity_alert_minutes > 0 && (
                <label className="field" style={{ marginTop: 12, maxWidth: 360 }}>
                  Inactive for at least
                  <div className="row gap-sm">
                    <input
                      type="number"
                      min={1}
                      max={240}
                      className="narrow"
                      value={s.inactivity_alert_minutes}
                      onChange={(e) =>
                        setS({ ...s, inactivity_alert_minutes: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                    <span className="muted">minutes</span>
                  </div>
                  <span className="hint">Running sessions pick up a new value within a minute.</span>
                </label>
              )}
            </div>
            {message && <div className={`alert ${message.kind === "ok" ? "success" : "error"}`}>{message.text}</div>}
            <div className="form-actions">
              <button className="btn primary" disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
