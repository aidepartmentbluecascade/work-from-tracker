import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../../api";
import { keys } from "../../queryClient";
import { useAuth } from "../../auth";
import Avatar from "../../components/Avatar";
import DeleteUserDialog from "../../components/DeleteUserDialog";
import { IconPlus, IconSearch, IconTrash, IconUsers } from "../../components/Icons";
import { allTimezones } from "../../format";
import { roleLabel, type Department, type Role, type User } from "../../types";

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
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const isLead = me?.role === "team_lead";

  const usersQ = useQuery({ queryKey: keys.users, queryFn: () => api<User[]>("/admin/users") });
  const deptsQ = useQuery({
    queryKey: keys.departments,
    queryFn: () => api<Department[]>("/admin/departments"),
    enabled: isAdmin,
  });
  const users = usersQ.data ?? null;
  const departments = (deptsQ.data ?? []).filter((d) => d.is_active);

  const [query, setQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [timezone, setTimezone] = useState(browserTz);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<User | null>(null);

  const load = () => qc.invalidateQueries({ queryKey: keys.users, exact: true });

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      const ids = u.department_ids?.length ? u.department_ids : u.department_id != null ? [u.department_id] : [];
      if (deptFilter === "unassigned" && ids.length > 0) return false;
      if (deptFilter !== "all" && deptFilter !== "unassigned" && !ids.includes(Number(deptFilter))) return false;
      if (!q) return true;
      return u.full_name.toLowerCase().includes(q) || u.email.includes(q);
    });
  }, [users, query, deptFilter]);

  const needsDepartment = role === "user" || role === "team_lead";

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        email,
        full_name: fullName,
        password,
        role: isLead ? "user" : role,
        timezone,
      };
      if (isLead) {
        // Backend forces department; omit client field.
      } else if (needsDepartment) {
        if (!departmentId) throw new Error("Select a department");
        body.department_id = Number(departmentId);
      } else {
        body.department_id = null;
      }
      await api<User>("/admin/users", { method: "POST", body });
      setEmail("");
      setFullName("");
      setPassword("");
      setRole("user");
      setDepartmentId("");
      setShowForm(false);
      await load();
      await qc.invalidateQueries({ queryKey: keys.departments });
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
          <p>
            {isLead
              ? "Add and manage employees in your department."
              : "Manage employees, team leads and admins across departments."}
          </p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((s) => !s)}>
          <IconPlus size={16} /> {showForm ? "Close" : isLead ? "Add employee" : "Add user"}
        </button>
      </div>
      {(error ?? usersQ.error?.message) && <div className="alert error">{error ?? usersQ.error?.message}</div>}

      {showForm && (
        <form className="card" onSubmit={create}>
          <div className="card-head">
            <h3>{isLead ? "New employee" : "New user"}</h3>
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
            {isAdmin && (
              <label className="field">
                Role
                <select
                  value={role}
                  onChange={(e) => {
                    const next = e.target.value as Role;
                    setRole(next);
                    if (next === "admin") setDepartmentId("");
                  }}
                >
                  <option value="user">Employee (tracked)</option>
                  <option value="team_lead">Team lead</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            )}
            {isAdmin && needsDepartment && (
              <label className="field">
                Department
                <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
                  <option value="">Select department…</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                {departments.length === 0 && (
                  <span className="hint">Create a department first under Departments.</span>
                )}
              </label>
            )}
            {isLead && (
              <label className="field">
                Department
                <input value={me?.department_name ?? "Your department"} disabled />
              </label>
            )}
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
                {busy ? "Creating…" : isLead ? "Create employee" : "Create user"}
              </button>
            </div>
          </div>
        </form>
      )}

      <section className="card">
        <div className="card-head">
          <h3>
            {isLead ? "Department users" : "All users"} <span className="sub">{filtered.length}</span>
          </h3>
          <div className="row gap wrap">
            {isAdmin && (
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ maxWidth: 200 }}>
                <option value="all">All departments</option>
                <option value="unassigned">Unassigned</option>
                {(deptsQ.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <div className="search">
              <IconSearch size={16} />
              <input placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
        </div>
        {users && filtered.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconUsers />
            </div>
            {query || deptFilter !== "all" ? "No users match your filters." : "No users yet."}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  {isAdmin && <th>Department</th>}
                  <th>Timezone</th>
                  <th>Screenshot every</th>
                  <th>Status</th>
                  <th style={{ width: 56 }} aria-label="Actions" />
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
                      <span className={`pill ${u.role === "admin" ? "indigo" : u.role === "team_lead" ? "amber" : ""}`}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    {isAdmin && (
                      <td>
                        {u.department_names?.length
                          ? u.department_names.join(", ")
                          : u.department_name ?? <span className="faint">—</span>}
                      </td>
                    )}
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
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                      <button
                        className="btn ghost icon row-delete"
                        onClick={() => setToDelete(u)}
                        disabled={u.id === me?.id || (isLead && u.role !== "user")}
                        title={
                          u.id === me?.id
                            ? "You can't delete your own account"
                            : isLead && u.role !== "user"
                              ? "Team leads can only delete employees"
                              : `Delete ${u.full_name}`
                        }
                        aria-label={`Delete ${u.full_name}`}
                      >
                        <IconTrash size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {toDelete && (
        <DeleteUserDialog
          user={toDelete}
          onClose={() => setToDelete(null)}
          onDeleted={() => {
            qc.setQueryData<User[]>(keys.users, (list) => list?.filter((x) => x.id !== toDelete.id));
            qc.removeQueries({ queryKey: keys.user(toDelete.id) });
            qc.invalidateQueries({ queryKey: keys.live });
            qc.invalidateQueries({ queryKey: ["attendance"] });
            qc.invalidateQueries({ queryKey: keys.departments });
            setToDelete(null);
          }}
        />
      )}
    </>
  );
}
