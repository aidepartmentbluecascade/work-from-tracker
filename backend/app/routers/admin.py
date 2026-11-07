"""Admin-only endpoints: users, timelines, settings, screenshots, locations, reports."""

from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import storage
from ..database import get_db
from ..deps import require_admin
from ..models import ActivityEvent, LocationPing, Role, Screenshot, User, WorkSchedule, WorkSession
from ..schemas import (
    AttendanceRow,
    AppSettingsOut,
    AppSettingsUpdate,
    EventOut,
    HoursRow,
    LiveUser,
    LocationOut,
    ScheduleUpdate,
    ScheduleWindow,
    ScreenshotOut,
    SessionOut,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..security import hash_password
from ..timeline import (
    close_stale_sessions,
    expected_window,
    get_app_settings,
    get_zone,
    local_day_bounds,
    session_seconds_in_range,
    utcnow,
    within_schedule,
)

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


def _with_url(shot: Screenshot) -> ScreenshotOut:
    out = ScreenshotOut.model_validate(shot)
    try:
        out.url = storage.signed_url(shot.gcs_object)
    except Exception:
        out.url = None
    return out


# ---------- users ----------

@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.full_name)).all()


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db)):
    exists = db.scalars(select(User).where(func.lower(User.email) == body.email.lower())).first()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")
    user = User(
        email=body.email.lower(),
        full_name=body.full_name,
        password_hash=hash_password(body.password),
        role=body.role,
        timezone=body.timezone,
        tracking_enabled=body.tracking_enabled,
        screenshot_interval_minutes=body.screenshot_interval_minutes,
    )
    db.add(user)
    db.commit()
    return user


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db)):
    return _user_or_404(db, user_id)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    user = _user_or_404(db, user_id)
    data = body.model_dump(exclude_unset=True)
    if user.id == admin.id and (data.get("is_active") is False or data.get("role") == Role.user):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot disable or demote your own account")
    if "password" in data:
        user.password_hash = hash_password(data.pop("password"))
    for key, value in data.items():
        if value is None and key != "screenshot_interval_minutes":
            continue  # only the interval override may be cleared with null
        setattr(user, key, value)
    db.commit()
    return user


@router.delete("/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """Permanently delete a user, all their tracking data, and their screenshots in GCS."""
    user = _user_or_404(db, user_id)
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete your own account")
    if user.role == Role.admin:
        admins = db.scalar(select(func.count()).select_from(User).where(User.role == Role.admin))
        if admins <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete the last admin")

    # Remove images first: if GCS fails we keep the DB rows, so nothing is left orphaned.
    try:
        deleted_images = storage.delete_user_screenshots(user.id)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Could not delete screenshots from storage: {exc}") from exc

    db.delete(user)  # sessions, screenshots, locations, events, schedule cascade in the database
    db.commit()
    return {"deleted": True, "screenshots_deleted": deleted_images}


# ---------- timeline (work schedule) ----------

@router.get("/users/{user_id}/schedule", response_model=list[ScheduleWindow])
def get_schedule(user_id: int, db: Session = Depends(get_db)):
    return _user_or_404(db, user_id).schedules


@router.put("/users/{user_id}/schedule", response_model=list[ScheduleWindow])
def set_schedule(user_id: int, body: ScheduleUpdate, db: Session = Depends(get_db)):
    user = _user_or_404(db, user_id)
    user.schedules = [
        WorkSchedule(weekday=w.weekday, start_time=w.start_time, end_time=w.end_time) for w in body.windows
    ]
    db.commit()
    db.refresh(user)
    return user.schedules


# ---------- global settings ----------

@router.get("/settings", response_model=AppSettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return get_app_settings(db)


@router.patch("/settings", response_model=AppSettingsOut)
def update_settings(body: AppSettingsUpdate, db: Session = Depends(get_db)):
    s = get_app_settings(db)
    for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(s, key, value)
    db.commit()
    return s


# ---------- per-user day view ----------

def _day_range(db: Session, user_id: int, day: date) -> tuple[User, datetime, datetime]:
    user = _user_or_404(db, user_id)
    start, end = local_day_bounds(day, user.timezone)
    return user, start, end


@router.get("/users/{user_id}/screenshots", response_model=list[ScreenshotOut])
def user_screenshots(user_id: int, day: date = Query(..., alias="date"), db: Session = Depends(get_db)):
    _, start, end = _day_range(db, user_id, day)
    shots = db.scalars(
        select(Screenshot)
        .where(Screenshot.user_id == user_id, Screenshot.captured_at >= start, Screenshot.captured_at < end)
        .order_by(Screenshot.captured_at)
    ).all()
    return [_with_url(s) for s in shots]


@router.get("/users/{user_id}/locations", response_model=list[LocationOut])
def user_locations(user_id: int, day: date = Query(..., alias="date"), db: Session = Depends(get_db)):
    _, start, end = _day_range(db, user_id, day)
    return db.scalars(
        select(LocationPing)
        .where(LocationPing.user_id == user_id, LocationPing.captured_at >= start, LocationPing.captured_at < end)
        .order_by(LocationPing.captured_at)
    ).all()


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
def user_sessions(user_id: int, day: date = Query(..., alias="date"), db: Session = Depends(get_db)):
    close_stale_sessions(db)
    _, start, end = _day_range(db, user_id, day)
    return db.scalars(
        select(WorkSession)
        .where(
            WorkSession.user_id == user_id,
            WorkSession.started_at < end,
            (WorkSession.ended_at.is_(None)) | (WorkSession.ended_at >= start),
        )
        .order_by(WorkSession.started_at)
    ).all()


@router.get("/users/{user_id}/events", response_model=list[EventOut])
def user_events(user_id: int, day: date = Query(..., alias="date"), db: Session = Depends(get_db)):
    _, start, end = _day_range(db, user_id, day)
    return db.scalars(
        select(ActivityEvent)
        .where(ActivityEvent.user_id == user_id, ActivityEvent.created_at >= start, ActivityEvent.created_at < end)
        .order_by(ActivityEvent.created_at)
    ).all()


# ---------- live + reports ----------

@router.get("/live", response_model=list[LiveUser])
def live(db: Session = Depends(get_db)):
    close_stale_sessions(db)
    sessions = db.scalars(select(WorkSession).where(WorkSession.ended_at.is_(None))).all()
    result: list[LiveUser] = []
    for s in sessions:
        user = db.get(User, s.user_id)
        if user is None:  # deleted while this request was running
            continue
        last_loc = db.scalars(
            select(LocationPing).where(LocationPing.session_id == s.id).order_by(LocationPing.captured_at.desc())
        ).first()
        last_shot = db.scalars(
            select(Screenshot).where(Screenshot.session_id == s.id).order_by(Screenshot.captured_at.desc())
        ).first()
        result.append(
            LiveUser(
                user=UserOut.model_validate(user),
                session=SessionOut.model_validate(s),
                within_schedule=within_schedule(user.schedules, user.timezone),
                last_location=LocationOut.model_validate(last_loc) if last_loc else None,
                last_screenshot=_with_url(last_shot) if last_shot else None,
            )
        )
    result.sort(key=lambda r: r.user.full_name)
    return result


EARLY_START_WINDOW = timedelta(hours=4)  # a session up to 4h before the expected start still counts for that day


def _attendance_for(db: Session, user: User, day: date, grace: timedelta, now: datetime) -> AttendanceRow:
    day_start, day_end = local_day_bounds(day, user.timezone)
    window = expected_window(user.schedules, day, user.timezone)

    # Which sessions count toward this day's attendance.
    if window:
        lo, hi = window[0] - EARLY_START_WINDOW, window[1]
    else:
        lo, hi = day_start, day_end
    first_start = db.scalars(
        select(WorkSession.started_at)
        .where(WorkSession.user_id == user.id, WorkSession.started_at >= lo, WorkSession.started_at < hi)
        .order_by(WorkSession.started_at)
    ).first()

    overlapping = db.scalars(
        select(WorkSession).where(
            WorkSession.user_id == user.id,
            WorkSession.started_at < day_end,
            (WorkSession.ended_at.is_(None)) | (WorkSession.ended_at > day_start),
        )
    ).all()
    worked = sum(session_seconds_in_range(s, day_start, day_end) for s in overlapping)
    is_working = any(s.ended_at is None for s in overlapping)

    late_minutes = 0
    if window is None:
        if first_start:
            status_ = "worked_day_off"
        else:
            status_ = "no_schedule" if not user.schedules else "day_off"
    else:
        expected_start, expected_end = window
        if first_start:
            late = first_start - expected_start
            if late > grace:
                status_ = "late"
                late_minutes = int(-(-late.total_seconds() // 60))  # round up
            else:
                status_ = "on_time"
        elif now < expected_start + grace:
            status_ = "upcoming"
        elif now < expected_end:
            status_ = "not_started"
        else:
            status_ = "absent"

    return AttendanceRow(
        user_id=user.id,
        full_name=user.full_name,
        email=user.email,
        timezone=user.timezone,
        day=day,
        expected_start=window[0] if window else None,
        expected_end=window[1] if window else None,
        first_start=first_start,
        worked_seconds=worked,
        status=status_,
        late_minutes=late_minutes,
        is_working=is_working,
    )


@router.get("/attendance", response_model=list[AttendanceRow])
def attendance(
    day: date | None = Query(None, alias="date", description="Local day; defaults to each user's today"),
    user_id: int | None = None,
    db: Session = Depends(get_db),
):
    close_stale_sessions(db)
    grace = timedelta(minutes=get_app_settings(db).late_grace_minutes)
    now = utcnow()
    q = select(User).where(User.role == Role.user, User.is_active.is_(True)).order_by(User.full_name)
    if user_id is not None:
        q = select(User).where(User.id == user_id)
    rows = []
    for user in db.scalars(q).all():
        user_day = day or now.astimezone(get_zone(user.timezone)).date()
        rows.append(_attendance_for(db, user, user_day, grace, now))
    return rows


@router.get("/reports/hours", response_model=list[HoursRow])
def hours_report(
    start: date = Query(..., description="First day (UTC), inclusive"),
    end: date = Query(..., description="Last day (UTC), inclusive"),
    db: Session = Depends(get_db),
):
    if end < start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "end must be on or after start")
    close_stale_sessions(db)
    range_start = datetime.combine(start, time.min, tzinfo=timezone.utc)
    range_end = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc)

    sessions = db.scalars(
        select(WorkSession).where(
            WorkSession.started_at < range_end,
            (WorkSession.ended_at.is_(None)) | (WorkSession.ended_at > range_start),
        )
    ).all()
    totals: dict[int, list[float]] = {}
    for s in sessions:
        secs = session_seconds_in_range(s, range_start, range_end)
        row = totals.setdefault(s.user_id, [0.0, 0])
        row[0] += secs
        row[1] += 1

    users = db.scalars(select(User).where(User.role == Role.user).order_by(User.full_name)).all()
    return [
        HoursRow(
            user_id=u.id,
            full_name=u.full_name,
            email=u.email,
            seconds=totals.get(u.id, [0.0, 0])[0],
            sessions=int(totals.get(u.id, [0.0, 0])[1]),
        )
        for u in users
    ]
