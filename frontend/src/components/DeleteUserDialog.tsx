import { useEffect, useState } from "react";
import { api } from "../api";
import { IconTrash } from "./Icons";
import type { User } from "../types";

interface Props {
  user: User;
  onClose: () => void;
  onDeleted: () => void;
}

/** Confirmation dialog: the admin must type the user's full name before deleting. */
export default function DeleteUserDialog({ user, onClose, onDeleted }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/users/${user.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">
          <IconTrash size={22} />
        </div>
        <h2>Delete {user.full_name}?</h2>
        <p className="muted" style={{ margin: 0 }}>
          This permanently deletes the account and <strong>all of their tracking data and screenshots</strong>. This
          can't be undone. To only block sign-in, turn off "Account active" on their profile instead.
        </p>
        <label className="field">
          <span>
            Type <strong>{user.full_name}</strong> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && typed.trim() === user.full_name && !busy && remove()}
            autoFocus
          />
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="form-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={remove} disabled={busy || typed.trim() !== user.full_name}>
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}
