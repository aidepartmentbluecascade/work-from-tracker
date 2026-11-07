import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../auth";
import AttendancePill from "../../components/AttendancePill";
import Avatar from "../../components/Avatar";
import {
  IconAlarm,
  IconCamera,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconPin,
  IconTrash,
} from "../../components/Icons";
import Lightbox, { type LightboxItem } from "../../components/Lightbox";
import LocationMap from "../../components/LocationMap";
import ScheduleEditor from "../../components/ScheduleEditor";
import { allTimezones, END_REASONS, fmtDuration, fmtTime, isoDate, todayIn } from "../../format";
import type {
  ActivityEvent,
  AttendanceRow,
  LocationPing,
  Role,
  Screenshot,
  User,
  WorkSession,
} from "../../types";
import { StatusPill } from "./Users";

type Tab = "activity" | "timeline" | "profile";

const TABS: { key: Tab; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "timeline", label: "Work timeline" },
  { key: "profile", label: "Profile & settings" },
];

export default function UserDetail() {
  const id = Number(useParams().id);
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<User>(`/admin/users/${id}`)
      .then(setUser)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="alert error">{error}</div>;
  if (!user) return <p className="muted">Loading…</p>;

  return (
    <>
      <div>
        <Link to="/admin/users" className="back">
          <IconChevronLeft size={14} /> All users
        </Link>
        <div className="page-head">
          <div className="person">
            <Avatar name={user.full_name} size={48} />
            <div>
              <h1>{user.full_name}</h1>
              <div className="row gap wrap muted small" style={{ marginTop: 2 }}>
                <span>{user.email}</span>
                <span className="faint">•</span>
                <span>{user.timezone}</span>
                <StatusPill user={user} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "activity" && <Activity user={user} />}
      {tab === "timeline" && (
        <section className="card card-pad">
          <ScheduleEditor userId={user.id} timezone={user.timezone} />
        </section>
      )}
      {tab === "profile" && (
        <>
          <Profile user={user} onSaved={setUser} />
          <DangerZone user={user} />
        </>
      )}
    </>
  );
}

function DangerZone({ user }: { user: User }) {
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSelf = me?.id === user.id;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/users/${user.id}`, { method: "DELETE" });
      navigate("/admin/users", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="card danger-zone">
      <div className="card-body row between wrap gap">
        <div>
          <h3>Delete user</h3>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {isSelf
              ? "You can't delete your own account."
              : "Permanently removes this user, their sessions, locations, events, and all screenshots in storage."}
          </p>
        </div>
        <button className="btn danger-outline" disabled={isSelf} onClick={() => setOpen(true)}>
          <IconTrash size={16} /> Delete user
        </button>
      </div>

      {open && (
        <div className="modal-backdrop" onClick={() => !busy && setOpen(false)}>
          <div className="modal card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon">
              <IconTrash size={22} />
            </div>
            <h2>Delete {user.full_name}?</h2>
            <p className="muted" style={{ margin: 0 }}>
              This permanently deletes the account and <strong>all of their tracking data and screenshots</strong>.
              This can't be undone. To only stop access, turn off "Account active" instead.
            </p>
            <label className="field">
              Type <strong>{user.full_name}</strong> to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
            {error && <div className="alert error">{error}</div>}
            <div className="form-actions">
              <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" onClick={remove} disabled={busy || typed.trim() !== user.full_name}>
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDate(d);
}

function Activity({ user }: { user: User }) {
  const tz = user.timezone;
  const today = todayIn(tz);
  const [day, setDay] = useState(today);
  const [shots, setShots] = useState<Screenshot[] | null>(null);
  const [pings, setPings] = useState<LocationPing[] | null>(null);
  const [sessions, setSessions] = useState<WorkSession[] | null>(null);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [att, setAtt] = useState<AttendanceRow | null>(null);

  useEffect(() => {
    setError(null);
    const q = `?date=${day}`;
    api<AttendanceRow[]>(`/admin/attendance?date=${day}&user_id=${user.id}`)
      .then((r) => setAtt(r[0] ?? null))
      .catch(() => setAtt(null));
    Promise.all([
      api<Screenshot[]>(`/admin/users/${user.id}/screenshots${q}`),
      api<LocationPing[]>(`/admin/users/${user.id}/locations${q}`),
      api<WorkSession[]>(`/admin/users/${user.id}/sessions${q}`),
      api<ActivityEvent[]>(`/admin/users/${user.id}/events${q}`),
    ])
      .then(([s, l, se, ev]) => {
        setShots(s);
        setPings(l);
        setSessions(se);
        setEvents(ev);
      })
      .catch((e) => setError(e.message));
  }, [user.id, day]);

  const totalSeconds =
    sessions?.reduce((sum, s) => {
      const end = s.ended_at ? new Date(s.ended_at) : new Date(s.last_heartbeat_at);
      return sum + Math.max(0, (end.getTime() - new Date(s.started_at).getTime()) / 1000);
    }, 0) ?? 0;

  const hourFmt = useMemo(() => new Intl.DateTimeFormat([], { hour: "numeric", timeZone: tz }), [tz]);
  const groups = useMemo(() => {
    const out: { label: string; items: { shot: Screenshot; index: number }[] }[] = [];
    (shots ?? []).forEach((shot, index) => {
      const label = hourFmt.format(new Date(shot.captured_at));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ shot, index });
      else out.push({ label, items: [{ shot, index }] });
    });
    return out;
  }, [shots, hourFmt]);

  const lightboxItems: LightboxItem[] = (shots ?? []).map((s) => ({
    url: s.url ?? "",
    title: fmtTime(s.captured_at, tz),
    subtitle: `${user.full_name} · ${day}${s.width ? ` · ${s.width}×${s.height}` : ""}`,
  }));

  return (
    <>
      <div className="row between wrap gap">
        <div className="date-nav">
          <button className="btn icon" onClick={() => setDay(shiftDay(day, -1))} title="Previous day">
            <IconChevronLeft />
          </button>
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="btn icon" onClick={() => setDay(shiftDay(day, 1))} disabled={day >= today} title="Next day">
            <IconChevronRight />
          </button>
          {day !== today && (
            <button className="btn ghost sm" onClick={() => setDay(today)}>
              Today
            </button>
          )}
        </div>
        <span className="faint small">Times shown in {tz}</span>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="grid stats">
        <div className="card stat-card">
          <div className={`stat-icon ${att?.status === "late" || att?.status === "absent" ? "red" : "green"}`}>
            <IconAlarm />
          </div>
          <div>
            <div className="stat-label">
              Started{att?.expected_start && <> · expected {fmtTime(att.expected_start, tz)}</>}
            </div>
            <div className="stat-value">{att?.first_start ? fmtTime(att.first_start, tz) : "–"}</div>
            {att && (
              <div style={{ marginTop: 4 }}>
                <AttendancePill row={att} />
              </div>
            )}
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon amber">
            <IconClock />
          </div>
          <div>
            <div className="stat-label">Time worked</div>
            <div className="stat-value">{fmtDuration(totalSeconds)}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon">
            <IconCamera />
          </div>
          <div>
            <div className="stat-label">Screenshots</div>
            <div className="stat-value">{shots?.length ?? "–"}</div>
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-icon green">
            <IconPin />
          </div>
          <div>
            <div className="stat-label">Location points</div>
            <div className="stat-value">{pings?.length ?? "–"}</div>
          </div>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>
            Screenshots <span className="sub">click to view</span>
          </h3>
        </div>
        <div className="card-body">
          {shots?.length === 0 && (
            <div className="empty">
              <div className="empty-icon">
                <IconCamera />
              </div>
              No screenshots on this day.
            </div>
          )}
          {groups.map((g) => (
            <div className="hour-group" key={g.label + g.items[0]!.index}>
              <div className="hour-label">{g.label}</div>
              <div className="shots">
                {g.items.map(({ shot, index }) => (
                  <button key={shot.id} className="shot" onClick={() => shot.url && setViewer(index)} title={shot.gcs_uri}>
                    {shot.url ? (
                      <img src={shot.url} alt={`Screenshot at ${fmtTime(shot.captured_at, tz)}`} loading="lazy" />
                    ) : (
                      <div className="shot-missing">Link unavailable</div>
                    )}
                    <span className="shot-time">{fmtTime(shot.captured_at, tz)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head">
            <h3>Location</h3>
          </div>
          <div className="card-body">{pings && <LocationMap pings={pings} timezone={tz} />}</div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Sessions</h3>
          </div>
          <div className="card-body">
            {sessions?.length === 0 && <p className="faint" style={{ margin: 0 }}>No sessions on this day.</p>}
            <ul className="timeline-list">
              {sessions?.map((s) => (
                <li key={s.id}>
                  <span className="t">{fmtTime(s.started_at, tz)}</span>
                  <span className="grow">
                    {s.ended_at ? (
                      <>until {fmtTime(s.ended_at, tz)}</>
                    ) : (
                      <span className="pill green">
                        <span className="dot" /> Live now
                      </span>
                    )}
                  </span>
                  {s.end_reason && <span className="faint small">{END_REASONS[s.end_reason] ?? s.end_reason}</span>}
                </li>
              ))}
            </ul>
            {events && events.length > 0 && (
              <>
                <h3 style={{ margin: "18px 0 6px" }}>Events</h3>
                <ul className="timeline-list scroll-y">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="t">{fmtTime(e.created_at, tz)}</span>
                      <span className="grow">
                        {e.event_type.replace(/_/g, " ")}
                        {e.detail && <span className="faint small"> — {e.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      </div>

      {viewer !== null && (
        <Lightbox items={lightboxItems} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
    </>
  );
}

function Profile({ user, onSaved }: { user: User; onSaved: (u: User) => void }) {
  const [fullName, setFullName] = useState(user.full_name);
  const [timezone, setTimezone] = useState(user.timezone);
  const [role, setRole] = useState<Role>(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [tracking, setTracking] = useState(user.tracking_enabled);
  const [useDefault, setUseDefault] = useState(user.screenshot_interval_minutes == null);
  const [intervalMin, setIntervalMin] = useState(user.screenshot_interval_minutes ?? 10);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const body: Record<string, unknown> = {
      full_name: fullName,
      timezone,
      role,
      is_active: isActive,
      tracking_enabled: tracking,
      screenshot_interval_minutes: useDefault ? null : intervalMin,
    };
    if (password) body.password = password;
    try {
      const u = await api<User>(`/admin/users/${user.id}`, { method: "PATCH", body });
      onSaved(u);
      setPassword("");
      setMessage({ kind: "ok", text: "Changes saved." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card-pad stack" onSubmit={save}>
      <div className="form-grid">
        <label className="field">
          Full name
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </label>
        <label className="field">
          Timezone
          <input list="tz-list-p" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
          <datalist id="tz-list-p">
            {allTimezones().map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
        <label className="field">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">Employee (tracked)</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="field">
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            placeholder="Leave blank to keep current"
          />
        </label>
      </div>

      <div className="form-section">
        <h3>Screenshot interval</h3>
        <p className="muted small" style={{ margin: "0 0 12px" }}>
          Override the global default for this person only.
        </p>
        <div className="row gap wrap">
          <label className="check">
            <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
            Use global default
          </label>
          {!useDefault && (
            <label className="row gap-sm">
              every
              <input
                type="number"
                min={1}
                max={240}
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
                className="narrow"
              />
              minutes
            </label>
          )}
        </div>
      </div>

      <div className="form-section">
        <h3>Access</h3>
        <div className="row gap wrap" style={{ marginTop: 10, gap: 24 }}>
          <label className="check">
            <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} />
            Tracking enabled
          </label>
          <label className="check">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Account active (can sign in)
          </label>
        </div>
      </div>

      {message && <div className={`alert ${message.kind === "ok" ? "success" : "error"}`}>{message.text}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
