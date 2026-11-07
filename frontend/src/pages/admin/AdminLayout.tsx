import { useEffect, useRef } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { useAuth } from "../../auth";
import Avatar from "../../components/Avatar";
import { IconBell, IconLogout, IconMonitor, IconPulse, IconSliders, IconUsers } from "../../components/Icons";
import { fmtDuration } from "../../format";
import { keys } from "../../queryClient";
import type { AlertsResponse } from "../../types";

/** Polls alerts for the sidebar badge and shows a desktop notification for each new one. */
function useAlertNotifications() {
  const navigate = useNavigate();
  const seen = useRef<Set<number> | null>(null);
  const alertsQ = useQuery({
    queryKey: keys.alerts,
    queryFn: () => api<AlertsResponse>("/admin/alerts"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const items = alertsQ.data?.items;
    if (!items) return;
    if (seen.current === null) {
      seen.current = new Set(items.map((a) => a.id)); // don't pop up old alerts on first load
      return;
    }
    const fresh = items.filter((a) => !seen.current!.has(a.id) && !a.read_at && !a.ended_at);
    fresh.forEach((a) => seen.current!.add(a.id));
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const a of fresh) {
      const n = new Notification(`${a.full_name} is inactive`, {
        body:
          a.kind === "locked"
            ? `Screen locked for ${fmtDuration(a.duration_seconds)}`
            : `No keyboard or mouse activity for ${fmtDuration(a.duration_seconds)}`,
        tag: `wfh-alert-${a.id}`,
      });
      n.onclick = () => {
        window.focus();
        navigate(`/admin/users/${a.user_id}`);
        n.close();
      };
    }
  }, [alertsQ.data, navigate]);

  return alertsQ.data?.unread ?? 0;
}

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const unread = useAlertNotifications();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark sm">
            <IconMonitor size={16} />
          </span>
          <span>WFH Tracker</span>
        </div>
        <nav className="nav">
          <NavLink to="/admin" end>
            <IconPulse /> Live
          </NavLink>
          <NavLink to="/admin/alerts">
            <IconBell /> Alerts
            {unread > 0 && <span className="nav-badge">{unread > 99 ? "99+" : unread}</span>}
          </NavLink>
          <NavLink to="/admin/users">
            <IconUsers /> Users
          </NavLink>
          <NavLink to="/admin/settings">
            <IconSliders /> Settings
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          {user && <Avatar name={user.full_name} size={30} />}
          <div className="person-text grow" style={{ minWidth: 0 }}>
            <div className="person-name small">{user?.full_name}</div>
            <div className="person-sub">Administrator</div>
          </div>
          <button className="btn ghost icon" onClick={logout} title="Sign out">
            <IconLogout />
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="main-inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
