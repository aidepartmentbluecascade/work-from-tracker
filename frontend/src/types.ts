export type Role = "admin" | "team_lead" | "user";

export interface Department {
  id: number;
  name: string;
  is_active: boolean;
  created_at: string;
  member_count: number;
  team_lead_count: number;
}

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  timezone: string;
  tracking_enabled: boolean;
  screenshot_interval_minutes: number | null;
  department_id: number | null;
  department_name: string | null;
  created_at: string;
}

export interface ScheduleWindow {
  weekday: number; // 0 = Monday
  start_time: string; // "HH:MM" or "HH:MM:SS"
  end_time: string;
}

export interface AppSettings {
  screenshot_interval_minutes: number;
  screenshot_jitter_percent: number;
  location_interval_minutes: number;
  late_grace_minutes: number;
  inactivity_alert_minutes: number;
}

export type AttendanceStatus =
  | "on_time"
  | "late"
  | "upcoming"
  | "not_started"
  | "absent"
  | "day_off"
  | "worked_day_off"
  | "no_schedule";

export interface AttendanceRow {
  user_id: number;
  full_name: string;
  email: string;
  timezone: string;
  department_id: number | null;
  department_name: string | null;
  day: string;
  expected_start: string | null;
  expected_end: string | null;
  first_start: string | null;
  worked_seconds: number;
  status: AttendanceStatus;
  late_minutes: number;
  is_working: boolean;
}

export interface TrackingConfig {
  tracking_enabled: boolean;
  within_schedule: boolean;
  screenshot_interval_minutes: number;
  screenshot_jitter_percent: number;
  location_interval_minutes: number;
  inactivity_alert_minutes: number;
  timezone: string;
  schedule: ScheduleWindow[];
  active_session_id: number | null;
}

export interface WorkSession {
  id: number;
  user_id: number;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface HeartbeatResponse {
  session_active: boolean;
  end_reason: string | null;
  config: TrackingConfig;
}

export interface LocationPing {
  id: number;
  session_id: number;
  captured_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
}

export interface Screenshot {
  id: number;
  session_id: number;
  captured_at: string;
  gcs_uri: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  url: string | null;
}

export interface ActivityEvent {
  id: number;
  session_id: number | null;
  event_type: string;
  detail: string | null;
  created_at: string;
}

export interface LiveUser {
  user: User;
  session: WorkSession;
  within_schedule: boolean;
  last_location: LocationPing | null;
  last_screenshot: Screenshot | null;
  inactive_since: string | null;
  inactive_kind: "idle" | "locked" | null;
}

export interface InactivityAlert {
  id: number;
  user_id: number;
  full_name: string;
  email: string;
  timezone: string;
  department_id: number | null;
  department_name: string | null;
  kind: "idle" | "locked";
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  read_at: string | null;
  duration_seconds: number;
}

export interface AlertsResponse {
  unread: number;
  items: InactivityAlert[];
}

export interface HoursRow {
  user_id: number;
  full_name: string;
  email: string;
  department_id: number | null;
  department_name: string | null;
  seconds: number;
  sessions: number;
}

export interface MyStats {
  seconds_today: number;
  seconds_this_week: number;
}

export function isManager(role: Role): boolean {
  return role === "admin" || role === "team_lead";
}

export function roleLabel(role: Role): string {
  if (role === "admin") return "Admin";
  if (role === "team_lead") return "Team lead";
  return "Employee";
}
