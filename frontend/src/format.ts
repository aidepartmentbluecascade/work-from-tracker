export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function fmtDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function fmtTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone });
}

export function fmtDateTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

export function hhmm(t: string): string {
  return t.slice(0, 5);
}

/** Today's date (YYYY-MM-DD) in a given IANA timezone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function allTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["UTC"];
}

export const EVENT_LABELS: Record<string, string> = {
  tab_hidden: "Left the tracker tab",
  tab_visible: "Returned to the tracker tab",
  location_unavailable: "Location unavailable",
  location_denied: "Location permission denied",
  capture_failed: "Screenshot failed",
  screen_locked: "Screen locked — tracking paused",
  screen_unlocked: "Screen unlocked — tracking resumed",
  session_resumed: "Tracking resumed after sleep / connection loss",
  blank_screen: "Screen was blank (locked or display off) — screenshot skipped",
  user_idle: "Inactive (no keyboard or mouse use)",
  user_active: "Active again",
  page_reloaded: "Page refreshed — tracking resumed",
  lock_detection_unavailable: "Lock detection not available in this browser",
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ");
}

export const END_REASONS: Record<string, string> = {
  manual: "Stopped by user",
  screen_locked: "Screen locked",
  sharing_stopped: "Screen sharing stopped",
  schedule_ended: "Scheduled hours ended",
  heartbeat_lost: "Connection lost / tab closed",
  superseded: "Restarted in another tab",
  tracking_disabled: "Tracking disabled by admin",
};
