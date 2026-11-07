import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import { IconPlus, IconSearch, IconUsers } from "../../components/Icons";
import { allTimezones } from "../../format";
import type { Role, User } from "../../types";

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function StatusPill({ user }: { user: User }) {
  if (!user.is_active)
    return (
      <span className="pill red">
        <span className="dot" /> Disabled
      </span>
    );
  if (user.role === "user" && !user.tracking_enabled)
    return (
      <span className="pill amber">
        <span className="dot" /> Tracking off
      </span>
    );
  return (
    <span className="pill green">
      <span className="dot" /> Active
    </span>
  );
}

export default function Users() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[] | null>(null);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [timezone, setTimezone] = useState(browserTz);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<User[]>("/admin/users")
      .then(setUsers)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!users) return [];
    return q ? users.filter((u) => u.full_name.toLowerCase().includes(q) || u.email.includes(q)) : users;
  }, [users, query]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<User>("/admin/users", {
        method: "POST",
        body: { email, full_name: fullName, password, role, timezone },
      });
      setEmail("");
      setFullName("");
      setPassword("");
      setRole("user");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Manage employees and admins, their timelines and capture settings.</p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((s) => !s)}>
          <IconPlus size={16} /> {showForm ? "Close" : "Add user"}
        </button>
      </div>
      {error && <div className="alert error">{error}</div>}

      {showForm && (
        <form className="card" onSubmit={create}>
          <div className="card-head">
            <h3>New user</h3>
          </div>
          <div className="card-body form-grid">
            <label className="field">
              Full name
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </label>
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
              <span className="hint">At least 8 characters</span>
            </label>
            <label className="field">
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="user">Employee (tracked)</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label className="field">
              Timezone
              <input list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
              <datalist id="tz-list">
                {allTimezones().map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
              <span className="hint">The work timeline uses this timezone</span>
            </label>
            <div className="form-actions span-all">
              <button type="button" className="btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? "Creating…" : "Create user"}
              </button>
            </div>
          </div>
        </form>
      )}

      <section className="card">
        <div className="card-head">
          <h3>
            All users <span className="sub">{users?.length ?? 0}</span>
          </h3>
          <div className="search">
            <IconSearch size={16} />
            <input placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {users && filtered.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconUsers />
            </div>
            {query ? "No users match your search." : "No users yet."}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Timezone</th>
                  <th>Screenshot every</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="click" onClick={() => navigate(`/admin/users/${u.id}`)}>
                    <td>
                      <div className="person">
                        <Avatar name={u.full_name} />
                        <div style={{ minWidth: 0 }}>
                          <div className="person-name">{u.full_name}</div>
                          <div className="person-sub">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${u.role === "admin" ? "indigo" : ""}`}>
                        {u.role === "admin" ? "Admin" : "Employee"}
                      </span>
                    </td>
                    <td>{u.timezone}</td>
                    <td>
                      {u.screenshot_interval_minutes ? (
                        `${u.screenshot_interval_minutes} min`
                      ) : (
                        <span className="faint">Default</span>
                      )}
                    </td>
                    <td>
                      <StatusPill user={u} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
