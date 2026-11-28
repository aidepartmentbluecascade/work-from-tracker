import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { keys } from "../queryClient";
import type { Department, User } from "../types";
import Avatar from "./Avatar";
import { IconSearch, IconUsers } from "./Icons";

interface Props {
  department: Department;
  onClose: () => void;
}

function inDept(u: User, departmentId: number): boolean {
  return (u.department_ids ?? []).includes(departmentId) || u.department_id === departmentId;
}

/** Admin picks which employees belong to a department (and thus its team leads). */
export default function AssignMembersDialog({ department, onClose }: Props) {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: keys.users, queryFn: () => api<User[]>("/admin/users") });
  const employees = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.role === "user").sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [usersQ.data],
  );
  const leads = useMemo(
    () =>
      (usersQ.data ?? [])
        .filter((u) => u.role === "team_lead" && u.department_id === department.id)
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [usersQ.data, department.id],
  );

  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed selection once users load.
  useEffect(() => {
    if (selected !== null || !usersQ.data) return;
    setSelected(new Set(employees.filter((u) => inDept(u, department.id)).map((u) => u.id)));
  }, [usersQ.data, employees, department.id, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((u) => u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [employees, query]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      await api<Department>(`/admin/departments/${department.id}/members`, {
        method: "PUT",
        body: { user_ids: [...selected] },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.departments }),
        qc.invalidateQueries({ queryKey: keys.users }),
        qc.invalidateQueries({ queryKey: keys.live }),
        qc.invalidateQueries({ queryKey: ["attendance"] }),
      ]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const selectedCount = selected?.size ?? 0;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal card modal-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-members-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-icon" style={{ background: "var(--primary-soft)", color: "var(--primary)" }}>
          <IconUsers size={22} />
        </div>
        <h2 id="assign-members-title">Assign members — {department.name}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Employees can belong to multiple departments. Checking someone here adds them for this
          department&apos;s team leads without removing them from others.
        </p>

        {leads.length > 0 ? (
          <div className="muted small">
            Team lead{leads.length > 1 ? "s" : ""}: {leads.map((l) => l.full_name).join(", ")}
          </div>
        ) : (
          <div className="alert" style={{ margin: 0 }}>
            No team lead in this department yet. Add one under Users, then assign members here.
          </div>
        )}

        <div className="search" style={{ width: "100%" }}>
          <IconSearch size={16} />
          <input
            placeholder="Search employees"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="member-picker">
          {usersQ.isLoading || selected === null ? (
            <div className="muted small" style={{ padding: 12 }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="muted small" style={{ padding: 12 }}>
              {employees.length === 0 ? "No employees yet. Create employees under Users first." : "No matches."}
            </div>
          ) : (
            filtered.map((u) => {
              const checked = selected.has(u.id);
              const otherNames = (u.department_names ?? []).filter((_, i) => (u.department_ids ?? [])[i] !== department.id);
              return (
                <label key={u.id} className={`member-row ${checked ? "on" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(u.id)} />
                  <Avatar name={u.full_name} size={28} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="person-name small">{u.full_name}</span>
                    <span className="person-sub">{u.email}</span>
                  </span>
                  {otherNames.length > 0 && (
                    <span className="pill amber" title={otherNames.join(", ")}>
                      Also in {otherNames.join(", ")}
                    </span>
                  )}
                  {(u.department_ids ?? []).length === 0 && !u.department_id && (
                    <span className="faint small">Unassigned</span>
                  )}
                </label>
              );
            })
          )}
        </div>

        {(error ?? usersQ.error?.message) && (
          <div className="alert error">{error ?? usersQ.error?.message}</div>
        )}

        <div className="form-actions" style={{ justifyContent: "space-between" }}>
          <span className="muted small">{selectedCount} selected</span>
          <div className="row gap">
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={busy || selected === null}>
              {busy ? "Saving…" : "Save members"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
