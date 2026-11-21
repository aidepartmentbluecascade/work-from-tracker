import { useEffect, useState } from "react";
import { IconLogout } from "./Icons";

interface Props {
  /** Extra note (e.g. that tracking will stop). */
  detail?: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

export default function LogoutDialog({ detail, onClose, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="logout-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">
          <IconLogout size={22} />
        </div>
        <h2 id="logout-title">Sign out?</h2>
        <p className="muted" style={{ margin: 0 }}>
          {detail ?? "You will need to sign in again to use WFH Tracker."}
        </p>
        <div className="form-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={confirm} disabled={busy} autoFocus>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
