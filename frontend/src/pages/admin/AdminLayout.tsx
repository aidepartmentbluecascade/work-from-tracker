import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../auth";
import Avatar from "../../components/Avatar";
import { IconLogout, IconMonitor, IconPulse, IconSliders, IconUsers } from "../../components/Icons";

export default function AdminLayout() {
  const { user, logout } = useAuth();
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
