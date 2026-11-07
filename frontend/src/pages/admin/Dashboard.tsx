import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { keys } from "../../queryClient";
import AttendancePill from "../../components/AttendancePill";
import Avatar from "../../components/Avatar";
import { IconAlarm, IconClock, IconPulse, IconUsers } from "../../components/Icons";
import Lightbox, { type LightboxItem } from "../../components/Lightbox";
import { fmtDateTime, fmtDuration, fmtTime, isoDate } from "../../format";
import type { AttendanceRow, HoursRow, LiveUser } from "../../types";

function startOfWeek(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return isoDate(d);
}

function since(iso: string): string {
  return fmtDuration((Date.now() - new Date(iso).getTime()) / 1000);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(startOfWeek());
  const [to, setTo] = useState(isoDate(new Date()));
  const [viewer, setViewer] = useState<number | null>(null);
  const [attDay, setAttDay] = useState(""); // "" = each employee's own today

  // Cached: revisiting the page shows the last data instantly, then refreshes every 30s.
  const liveQ = useQuery({
    queryKey: keys.live,
    queryFn: () => api<LiveUser[]>("/admin/live"),
    refetchInterval: 30_000,
  });
  const attQ = useQuery({
    queryKey: keys.attendance(attDay || "today"),
    queryFn: () => api<AttendanceRow[]>(`/admin/attendance${attDay ? `?date=${attDay}` : ""}`),
    refetchInterval: attDay ? false : 30_000,
  });
  const hoursQ = useQuery({
    queryKey: keys.hours(from, to),
    queryFn: () => api<HoursRow[]>(`/admin/reports/hours?start=${from}&end=${to}`),
    placeholderData: keepPreviousData,
  });
  const live = liveQ.data ?? null;
  const attendance = attQ.data ?? null;
  const hours = hoursQ.data ?? null;
  const error = (liveQ.error ?? attQ.error ?? hoursQ.error)?.message ?? null;

  const lateByUser = useMemo(() => {
    const m = new Map<number, AttendanceRow>();
    if (!attDay) attendance?.forEach((a) => m.set(a.user_id, a));
    return m;
  }, [attendance, attDay]);
  const lateCount = attendance?.filter((a) => a.status === "late").length ?? 0;
  const missingCount = attendance?.filter((a) => a.status === "not_started" || a.status === "absent").length ?? 0;
  const ATT_ORDER: Record<string, number> = {
    late: 0, absent: 1, not_started: 2, on_time: 3, worked_day_off: 4, upcoming: 5, day_off: 6, no_schedule: 7,
  };
  const sortedAttendance = [...(attendance ?? [])].sort(
    (a, b) => ATT_ORDER[a.status]! - ATT_ORDER[b.status]! || b.late_minutes - a.late_minutes,
  );

  const withShots = useMemo(() => (live ?? []).filter((l) => l.last_screenshot?.url), [live]);
  const lightboxItems: LightboxItem[] = withShots.map((l) => ({
    url: l.last_screenshot!.url!,
    title: l.user.full_name,
    subtitle: `Captured ${fmtDateTime(l.last_screenshot!.captured_at, l.user.timezone)} (${l.user.timezone})`,
  }));

  const totalSeconds = hours?.reduce((s, h) => s + h.seconds, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live overview</h1>
          <p>Who is working right now. Refreshes every 30 seconds.</p>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="grid stats">
        <div className="card stat-card">
          <div className="stat-icon green">
            <IconPulse />
          </div>
          <div>
            <div className="stat-label">Working now</div>
            <div className="stat-value">{live?.length ?? "–"}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon red">
            <IconAlarm />
          </div>
          <div>
            <div className="stat-label">Late {attDay ? "on " + attDay : "today"}</div>
            <div className="stat-value">{attendance ? lateCount : "–"}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon">
            <IconUsers />
          </div>
          <div>
            <div className="stat-label">Not started / absent</div>
            <div className="stat-value">{attendance ? missingCount : "–"}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon amber">
            <IconClock />
          </div>
          <div>
            <div className="stat-label">Hours in range</div>
            <div className="stat-value">{fmtDuration(totalSeconds)}</div>
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            Working now <span className="sub">{live?.length ?? 0} online</span>
          </h3>
        </div>
        {live && live.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconPulse />
            </div>
            Nobody is working right now.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Working for</th>
                  <th>Last location</th>
                  <th>Latest screenshot</th>
                </tr>
              </thead>
              <tbody>
                {live?.map((l) => {
                  const shotIndex = withShots.indexOf(l);
                  return (
                    <tr key={l.session.id} className="click" onClick={() => navigate(`/admin/users/${l.user.id}`)}>
                      <td>
                        <div className="person">
                          <Avatar name={l.user.full_name} />
                          <div>
                            <div className="person-name row gap-sm">
                              {l.user.full_name} <span className="live-dot" />
                              {lateByUser.get(l.user.id)?.status === "late" && (
                                <AttendancePill row={lateByUser.get(l.user.id)!} />
                              )}
                            </div>
                            <div className="person-sub">{l.user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="mono">{since(l.session.started_at)}</div>
                        <div className="faint small">since {fmtTime(l.session.started_at, l.user.timezone)}</div>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {l.last_location ? (
                          <a
                            href={`https://www.google.com/maps?q=${l.last_location.latitude},${l.last_location.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mono"
                          >
                            {l.last_location.latitude.toFixed(4)}, {l.last_location.longitude.toFixed(4)}
                          </a>
                        ) : (
                          <span className="faint">No location yet</span>
                        )}
                        {l.last_location?.accuracy_m != null && (
                          <div className="faint small">±{Math.round(l.last_location.accuracy_m)} m</div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {shotIndex >= 0 ? (
                          <div className="row gap">
                            <button className="thumb-btn" onClick={() => setViewer(shotIndex)} title="View screenshot">
                              <img src={l.last_screenshot!.url!} alt="Latest screenshot" />
                            </button>
                            <span className="faint small">{fmtTime(l.last_screenshot!.captured_at, l.user.timezone)}</span>
                          </div>
                        ) : (
                          <span className="faint">None yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>
            Attendance <span className="sub">{attDay ? attDay : "today, in each employee's timezone"}</span>
          </h3>
          <div className="row gap-sm">
            <input type="date" value={attDay} onChange={(e) => setAttDay(e.target.value)} />
            {attDay && (
              <button className="btn ghost sm" onClick={() => setAttDay("")}>
                Today
              </button>
            )}
          </div>
        </div>
        {attendance && attendance.length === 0 ? (
          <div className="empty">No active employees yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Expected start</th>
                  <th>Started</th>
                  <th>Worked</th>
                </tr>
              </thead>
              <tbody>
                {sortedAttendance.map((a) => (
                  <tr key={a.user_id} className="click" onClick={() => navigate(`/admin/users/${a.user_id}`)}>
                    <td>
                      <div className="person">
                        <Avatar name={a.full_name} size={28} />
                        <span className="person-name row gap-sm">
                          {a.full_name}
                          {a.is_working && <span className="live-dot" title="Working now" />}
                        </span>
                      </div>
                    </td>
                    <td>
                      <AttendancePill row={a} />
                    </td>
                    <td className="mono">
                      {a.expected_start ? fmtTime(a.expected_start, a.timezone) : <span className="faint">—</span>}
                    </td>
                    <td className="mono">
                      {a.first_start ? (
                        <span style={a.status === "late" ? { color: "#b91c1c", fontWeight: 600 } : undefined}>
                          {fmtTime(a.first_start, a.timezone)}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="mono">{fmtDuration(a.worked_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Hours worked</h3>
          <div className="row gap-sm">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="faint">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Sessions</th>
                <th style={{ width: "40%" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {hours?.length === 0 && (
                <tr>
                  <td colSpan={3} className="faint">
                    No employees yet. <Link to="/admin/users">Add one</Link>.
                  </td>
                </tr>
              )}
              {hours?.map((h) => {
                const max = Math.max(...hours.map((x) => x.seconds), 1);
                return (
                  <tr key={h.user_id} className="click" onClick={() => navigate(`/admin/users/${h.user_id}`)}>
                    <td>
                      <div className="person">
                        <Avatar name={h.full_name} size={28} />
                        <span className="person-name">{h.full_name}</span>
                      </div>
                    </td>
                    <td className="mono">{h.sessions}</td>
                    <td>
                      <div className="row gap">
                        <div style={{ flex: 1, height: 6, background: "#eef0f4", borderRadius: 99, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${(h.seconds / max) * 100}%`,
                              height: "100%",
                              background: "var(--primary)",
                              borderRadius: 99,
                            }}
                          />
                        </div>
                        <span className="mono" style={{ minWidth: 64, textAlign: "right" }}>
                          {fmtDuration(h.seconds)}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="faint small" style={{ margin: 0 }}>
        Hours range uses UTC dates.
      </p>

      {viewer !== null && lightboxItems.length > 0 && (
        <Lightbox
          items={lightboxItems}
          index={Math.min(viewer, lightboxItems.length - 1)}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
        />
      )}
    </>
  );
}
