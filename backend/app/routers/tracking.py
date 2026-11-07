"""Endpoints used by the employee's browser while they work."""

from datetime import timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import storage
from ..alerts import close_open_alerts, handle_event
from ..config import settings
from ..database import get_db
from ..deps import get_current_user
from ..models import ActivityEvent, LocationPing, Screenshot, User, WorkSession
from ..schemas import (
    EventIn,
    HeartbeatOut,
    LocationIn,
    LocationOut,
    MyStats,
    ScheduleWindow,
    SessionOut,
    StopSession,
    TrackingConfig,
)
from ..timeline import (
    close_stale_sessions,
    effective_interval,
    get_app_settings,
    get_zone,
    local_day_bounds,
    open_session,
    session_seconds_in_range,
    stale_cutoff,
    utcnow,
    within_schedule,
)

router = APIRouter(prefix="/api/tracking", tags=["tracking"])


def build_config(db: Session, user: User) -> TrackingConfig:
    app = get_app_settings(db)
    active = open_session(db, user.id)
    return TrackingConfig(
        tracking_enabled=user.tracking_enabled,
        within_schedule=within_schedule(user.schedules, user.timezone),
        screenshot_interval_minutes=effective_interval(user, app),
        screenshot_jitter_percent=app.screenshot_jitter_percent,
        location_interval_minutes=app.location_interval_minutes,
        inactivity_alert_minutes=app.inactivity_alert_minutes,
        timezone=user.timezone,
        schedule=[ScheduleWindow.model_validate(s) for s in user.schedules],
        active_session_id=active.id if active else None,
    )


def get_live_session(db: Session, user: User, session_id: int) -> WorkSession:
    s = db.get(WorkSession, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if s.ended_at is not None or s.last_heartbeat_at < stale_cutoff():
        raise HTTPException(status.HTTP_409_CONFLICT, "Session has ended")
    return s


def end_session(db: Session, s: WorkSession, reason: str) -> None:
    s.ended_at = utcnow()
    s.end_reason = reason
    db.commit()


@router.get("/config", response_model=TrackingConfig)
def config(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return build_config(db, user)


@router.post("/sessions/start", response_model=SessionOut)
def start_session(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # The work timeline is informational only: employees may start at any time (late, early, extra hours).
    if not user.tracking_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Tracking is disabled for your account")

    close_stale_sessions(db)
    existing = open_session(db, user.id)
    if existing:  # e.g. a second tab or a reload — keep only one live session
        end_session(db, existing, "superseded")

    now = utcnow()
    s = WorkSession(
        user_id=user.id,
        started_at=now,
        last_heartbeat_at=now,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(s)
    db.commit()
    return s


@router.post("/sessions/{session_id}/resume", response_model=SessionOut)
def resume_session(session_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Continue an open session after the page was refreshed (404/409 if it already ended)."""
    if not user.tracking_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Tracking is disabled for your account")
    s = get_live_session(db, user, session_id)
    s.last_heartbeat_at = utcnow()
    db.commit()
    return s


@router.post("/sessions/{session_id}/heartbeat", response_model=HeartbeatOut)
def heartbeat(session_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = db.get(WorkSession, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if s.ended_at is None:
        if s.last_heartbeat_at < stale_cutoff():
            s.ended_at, s.end_reason = s.last_heartbeat_at, "heartbeat_lost"
        elif not user.tracking_enabled:
            s.ended_at, s.end_reason = utcnow(), "tracking_disabled"
        else:
            s.last_heartbeat_at = utcnow()
        db.commit()

    return HeartbeatOut(session_active=s.ended_at is None, end_reason=s.end_reason, config=build_config(db, user))


@router.post("/sessions/{session_id}/stop", response_model=SessionOut)
def stop_session(
    session_id: int, body: StopSession, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    s = db.get(WorkSession, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if s.ended_at is None:
        end_session(db, s, body.reason)
    if body.reason != "screen_locked":  # a lock pause keeps its alert open until unlock
        close_open_alerts(db, user.id)
    return s


def _sniff_image(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.post("/screenshots", status_code=status.HTTP_201_CREATED)
def upload_screenshot(
    session_id: int = Form(...),
    width: int | None = Form(None),
    height: int | None = Form(None),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = get_live_session(db, user, session_id)

    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = file.file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Screenshot too large")
    content_type = _sniff_image(data)
    if content_type is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "File must be a JPEG, PNG or WebP image")

    captured_at = utcnow()
    try:
        object_name, gs_uri = storage.upload_screenshot(user.id, captured_at, data, content_type)
    except Exception as exc:  # GCS errors, missing config
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Could not store screenshot: {exc}") from exc

    shot = Screenshot(
        user_id=user.id,
        session_id=s.id,
        captured_at=captured_at,
        gcs_object=object_name,
        gcs_uri=gs_uri,
        content_type=content_type,
        size_bytes=len(data),
        width=width,
        height=height,
    )
    s.last_heartbeat_at = captured_at
    db.add(shot)
    db.commit()
    return {"id": shot.id, "captured_at": captured_at, "gcs_uri": gs_uri}


@router.post("/locations", response_model=LocationOut, status_code=status.HTTP_201_CREATED)
def add_location(body: LocationIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = get_live_session(db, user, body.session_id)
    ping = LocationPing(
        user_id=user.id,
        session_id=s.id,
        captured_at=utcnow(),
        latitude=body.latitude,
        longitude=body.longitude,
        accuracy_m=body.accuracy_m,
    )
    db.add(ping)
    db.commit()
    return ping


@router.post("/events", status_code=status.HTTP_201_CREATED)
def add_event(body: EventIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.session_id is not None:
        s = db.get(WorkSession, body.session_id)
        if s is None or s.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    db.add(ActivityEvent(user_id=user.id, session_id=body.session_id, event_type=body.event_type, detail=body.detail))
    db.commit()
    handle_event(db, user, body.event_type, body.session_id)
    return {"ok": True}


@router.get("/me/stats", response_model=MyStats)
def my_stats(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    today = utcnow().astimezone(get_zone(user.timezone)).date()
    day_start, day_end = local_day_bounds(today, user.timezone)
    week_start, _ = local_day_bounds(today - timedelta(days=today.weekday()), user.timezone)
    sessions = db.scalars(
        select(WorkSession).where(
            WorkSession.user_id == user.id,
            WorkSession.started_at < day_end,
            (WorkSession.ended_at.is_(None)) | (WorkSession.ended_at > week_start),
        )
    ).all()
    return MyStats(
        seconds_today=sum(session_seconds_in_range(s, day_start, day_end) for s in sessions),
        seconds_this_week=sum(session_seconds_in_range(s, week_start, day_end) for s in sessions),
    )
