import { useEffect, useState } from "react";
import { api } from "../api";
import { hhmm, WEEKDAYS } from "../format";
import { IconPlus, IconX } from "./Icons";
import type { ScheduleWindow } from "../types";

interface Props {
  userId: number;
  timezone: string;
}

export default function ScheduleEditor({ userId, timezone }: Props) {
  const [rows, setRows] = useState<ScheduleWindow[]>([]);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ScheduleWindow[]>(`/admin/users/${userId}/schedule`)
      .then((r) => setRows(r.map((w) => ({ ...w, start_time: hhmm(w.start_time), end_time: hhmm(w.end_time) }))))
      .catch((e) => setMessage({ kind: "error", text: e.message }));
  }, [userId]);

  const update = (i: number, patch: Partial<ScheduleWindow>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const add = () => setRows((r) => [...r, { weekday: 0, start_time: "09:00", end_time: "17:00" }]);

  const preset = () =>
    setRows([0, 1, 2, 3, 4].map((d) => ({ weekday: d, start_time: "09:00", end_time: "17:00" })));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/admin/users/${userId}/schedule`, { method: "PUT", body: { windows: rows } });
      setMessage({ kind: "ok", text: "Working hours saved." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h3>Working hours</h3>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          The employee's expected working hours ({timezone}), shown on their page. They can still start work at any
          time, and are tracked whenever they work. An end time earlier than the start time runs overnight.
        </p>
      </div>

      <div>
        {rows.length === 0 && (
          <div className="empty" style={{ padding: "20px 0" }}>
            No working hours set.
          </div>
        )}
        {rows.map((row, i) => (
          <div className="schedule-row" key={i}>
            <select value={row.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, idx) => (
                <option key={d} value={idx}>
                  {d}
                </option>
              ))}
            </select>
            <input type="time" value={row.start_time} onChange={(e) => update(i, { start_time: e.target.value })} />
            <span className="faint">→</span>
            <input type="time" value={row.end_time} onChange={(e) => update(i, { end_time: e.target.value })} />
            {row.end_time < row.start_time && <span className="pill amber">overnight</span>}
            <span className="grow" />
            <button
              className="btn ghost icon"
              onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}
              title="Remove window"
            >
              <IconX size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="row gap wrap">
        <button className="btn" onClick={add}>
          <IconPlus size={16} /> Add window
        </button>
        <button className="btn" onClick={preset}>
          Mon–Fri, 09:00–17:00
        </button>
        {rows.length > 0 && (
          <button className="btn ghost" onClick={() => setRows([])}>
            Clear all
          </button>
        )}
        <span className="grow" />
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save timeline"}
        </button>
      </div>
      {message && <div className={`alert ${message.kind === "ok" ? "success" : "error"}`}>{message.text}</div>}
    </div>
  );
}
