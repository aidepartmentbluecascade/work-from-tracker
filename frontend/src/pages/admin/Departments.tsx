import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { IconBuilding, IconPlus } from "../../components/Icons";
import { keys } from "../../queryClient";
import type { Department } from "../../types";

export default function Departments() {
  const qc = useQueryClient();
  const deptsQ = useQuery({
    queryKey: keys.departments,
    queryFn: () => api<Department[]>("/admin/departments"),
  });
  const depts = deptsQ.data ?? [];
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Department | null>(null);
  const [editName, setEditName] = useState("");

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<Department>("/admin/departments", { method: "POST", body: { name } });
      setName("");
      setShowForm(false);
      await qc.invalidateQueries({ queryKey: keys.departments });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api<Department>(`/admin/departments/${editing.id}`, {
        method: "PATCH",
        body: { name: editName },
      });
      setEditing(null);
      await qc.invalidateQueries({ queryKey: keys.departments });
      await qc.invalidateQueries({ queryKey: keys.users });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(dept: Department) {
    setError(null);
    try {
      await api<Department>(`/admin/departments/${dept.id}`, {
        method: "PATCH",
        body: { is_active: !dept.is_active },
      });
      await qc.invalidateQueries({ queryKey: keys.departments });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Departments</h1>
          <p>Create departments and assign team leads from the Users page.</p>
        </div>
        <button className="btn primary" onClick={() => setShowForm((s) => !s)}>
          <IconPlus size={16} /> {showForm ? "Close" : "Add department"}
        </button>
      </div>

      {(error ?? deptsQ.error?.message) && (
        <div className="alert error">{error ?? deptsQ.error?.message}</div>
      )}

      {showForm && (
        <form className="card" onSubmit={create}>
          <div className="card-head">
            <h3>New department</h3>
          </div>
          <div className="card-body form-grid">
            <label className="field span-all">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </label>
            <div className="form-actions span-all">
              <button type="button" className="btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? "Creating…" : "Create department"}
              </button>
            </div>
          </div>
        </form>
      )}

      {editing && (
        <form className="card" onSubmit={saveEdit}>
          <div className="card-head">
            <h3>Rename department</h3>
          </div>
          <div className="card-body form-grid">
            <label className="field span-all">
              Name
              <input value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            </label>
            <div className="form-actions span-all">
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>
      )}

      <section className="card">
        <div className="card-head">
          <h3>
            All departments <span className="sub">{depts.length}</span>
          </h3>
        </div>
        {depts.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconBuilding />
            </div>
            No departments yet. Create one, then add a team lead for it under Users.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Team leads</th>
                  <th>Members</th>
                  <th>Status</th>
                  <th style={{ width: 180 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {depts.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="person-name">{d.name}</div>
                    </td>
                    <td>{d.team_lead_count}</td>
                    <td>{d.member_count}</td>
                    <td>
                      {d.is_active ? (
                        <span className="pill green">
                          <span className="dot" /> Active
                        </span>
                      ) : (
                        <span className="pill red">
                          <span className="dot" /> Inactive
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div className="row gap" style={{ justifyContent: "flex-end" }}>
                        <button
                          className="btn sm"
                          onClick={() => {
                            setEditing(d);
                            setEditName(d.name);
                          }}
                        >
                          Rename
                        </button>
                        <button className="btn sm" onClick={() => toggleActive(d)}>
                          {d.is_active ? "Deactivate" : "Activate"}
                        </button>
                      </div>
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
