import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import { IconBell } from "../../components/Icons";
import { fmtDateTime, fmtDuration } from "../../format";
import { keys } from "../../queryClient";
import type { AlertsResponse } from "../../types";

function notificationState(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export default function Alerts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const alertsQ = useQuery({
    queryKey: keys.alerts,
    queryFn: () => api<AlertsResponse>("/admin/alerts"),
    refetchInterval: 30_000,
  });
  const [notif, setNotif] = useState(notificationState());

  async function markAllRead() {
    await api("/admin/alerts/read-all", { method: "POST" });
    qc.invalidateQueries({ queryKey: keys.alerts });
  }

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    setNotif(await Notification.requestPermission());
  }

  const items = alertsQ.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inactivity alerts</h1>
          <p>Employees with no keyboard or mouse activity, or a locked screen, longer than the limit in Settings.</p>
        </div>
        <div className="row gap wrap">
          {notif === "default" && (
            <button className="btn" onClick={enableNotifications}>
              <IconBell size={16} /> Enable desktop notifications
            </button>
          )}
          {notif === "granted" && <span className="pill green">Desktop notifications on</span>}
          {notif === "denied" && (
            <span className="pill" title="Allow notifications for this site in your browser settings">
              Desktop notifications blocked
            </span>
          )}
          <button className="btn" onClick={markAllRead} disabled={!alertsQ.data?.unread}>
            Mark all read
          </button>
        </div>
      </div>
      {alertsQ.error && <div className="alert error">{alertsQ.error.message}</div>}

      <section className="card">
        {alertsQ.data && items.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconBell />
            </div>
            No inactivity alerts yet.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Inactive since</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr
                    key={a.id}
                    className={`click ${a.read_at ? "" : "unread"}`}
                    onClick={() => navigate(`/admin/users/${a.user_id}`)}
                  >
                    <td>
                      <div className="person">
                        <Avatar name={a.full_name} size={30} />
                        <div style={{ minWidth: 0 }}>
                          <div className="person-name row gap-sm">
                            {!a.read_at && <span className="unread-dot" title="Unread" />}
                            {a.full_name}
                          </div>
                          <div className="person-sub">{a.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${a.kind === "locked" ? "indigo" : "amber"}`}>
                        {a.kind === "locked" ? "Screen locked" : "No activity"}
                      </span>
                    </td>
                    <td className="mono">{fmtDateTime(a.started_at, a.timezone)}</td>
                    <td className="mono">{fmtDuration(a.duration_seconds)}</td>
                    <td>
                      {a.ended_at ? (
                        <span className="faint">Back {fmtDateTime(a.ended_at, a.timezone)}</span>
                      ) : (
                        <span className="pill red">
                          <span className="dot" /> Still inactive
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="faint small" style={{ margin: 0 }}>
        Employees are not notified. Detection works in Chrome and Edge when the employee allowed activity detection at
        start.
      </p>
    </>
  );
}
