"""Work-timeline (schedule) and session-time helpers."""

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import settings
from .models import AppSettings, User, WorkSchedule, WorkSession


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def get_zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def is_valid_timezone(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def within_schedule(schedules: list[WorkSchedule], tz_name: str, now: datetime | None = None) -> bool:
    """True if `now` falls inside any of the user's working windows. No windows = no restriction."""
    if not schedules:
        return True
    local = (now or utcnow()).astimezone(get_zone(tz_name))
    t: time = local.time().replace(tzinfo=None)
    today = local.weekday()
    yesterday = (today - 1) % 7
    for s in schedules:
        if s.start_time < s.end_time:
            if s.weekday == today and s.start_time <= t < s.end_time:
                return True
        else:  # overnight window, e.g. 22:00 -> 06:00
            if s.weekday == today and t >= s.start_time:
                return True
            if s.weekday == yesterday and t < s.end_time:
                return True
    return False


def local_day_bounds(day: date, tz_name: str) -> tuple[datetime, datetime]:
    """UTC start/end of a calendar day in the given timezone."""
    tz = get_zone(tz_name)
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def get_app_settings(db: Session) -> AppSettings:
    s = db.get(AppSettings, 1)
    if s is None:
        s = AppSettings(id=1)
        db.add(s)
        db.commit()
    return s


def effective_interval(user: User, app: AppSettings) -> int:
    return user.screenshot_interval_minutes or app.screenshot_interval_minutes


def stale_cutoff() -> datetime:
    return utcnow() - timedelta(minutes=settings.heartbeat_timeout_minutes)


def close_stale_sessions(db: Session) -> None:
    """End sessions whose browser stopped sending heartbeats (tab closed, PC off, etc.)."""
    db.execute(
        update(WorkSession)
        .where(WorkSession.ended_at.is_(None), WorkSession.last_heartbeat_at < stale_cutoff())
        .values(ended_at=WorkSession.last_heartbeat_at, end_reason="heartbeat_lost")
    )
    db.commit()


def open_session(db: Session, user_id: int) -> WorkSession | None:
    return db.scalars(
        select(WorkSession)
        .where(WorkSession.user_id == user_id, WorkSession.ended_at.is_(None))
        .order_by(WorkSession.started_at.desc())
    ).first()


def expected_window(schedules: list[WorkSchedule], day: date, tz_name: str) -> tuple[datetime, datetime] | None:
    """Expected (start, end) in UTC for a local day, from the windows that START on that weekday."""
    todays = [s for s in schedules if s.weekday == day.weekday()]
    if not todays:
        return None
    tz = get_zone(tz_name)
    starts, ends = [], []
    for s in todays:
        start = datetime.combine(day, s.start_time, tzinfo=tz)
        end_day = day if s.end_time > s.start_time else day + timedelta(days=1)
        starts.append(start)
        ends.append(datetime.combine(end_day, s.end_time, tzinfo=tz))
    return min(starts).astimezone(timezone.utc), max(ends).astimezone(timezone.utc)


def session_seconds_in_range(s: WorkSession, start: datetime, end: datetime) -> float:
    s_end = s.ended_at or min(utcnow(), s.last_heartbeat_at + timedelta(minutes=1))
    overlap = min(s_end, end) - max(s.started_at, start)
    return max(overlap.total_seconds(), 0.0)
