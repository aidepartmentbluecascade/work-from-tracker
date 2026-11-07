import type { AttendanceRow } from "../types";

export function lateText(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function AttendancePill({ row }: { row: Pick<AttendanceRow, "status" | "late_minutes"> }) {
  switch (row.status) {
    case "late":
      return (
        <span className="pill red" title="Started after expected start + grace period">
          <span className="dot" /> Late {lateText(row.late_minutes)}
        </span>
      );
    case "on_time":
      return (
        <span className="pill green">
          <span className="dot" /> On time
        </span>
      );
    case "not_started":
      return (
        <span className="pill amber">
          <span className="dot" /> Not started
        </span>
      );
    case "absent":
      return (
        <span className="pill red">
          <span className="dot" /> Absent
        </span>
      );
    case "upcoming":
      return <span className="pill">Starts later</span>;
    case "worked_day_off":
      return <span className="pill indigo">Worked day off</span>;
    case "day_off":
      return <span className="pill">Day off</span>;
    default:
      return <span className="pill">No schedule</span>;
  }
}
