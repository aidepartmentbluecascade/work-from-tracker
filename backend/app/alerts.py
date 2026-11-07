"""Turns activity events from the employee's browser into admin-only inactivity alerts.

- user_idle      -> idle alert (the browser only reports this after N minutes without input)
- user_active    -> closes the open idle alert
- screen_locked  -> locked alert that becomes visible once the lock has lasted N minutes
- screen_unlocked-> closes it (or drops it if the lock was shorter than N minutes)
- manual stop    -> closes any open alerts
"""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import InactivityAlert, User
from .timeline import get_app_settings, utcnow


def _open_alert(db: Session, user_id: int, kind: str) -> InactivityAlert | None:
    return db.scalars(
        select(InactivityAlert)
        .where(InactivityAlert.user_id == user_id, InactivityAlert.kind == kind, InactivityAlert.ended_at.is_(None))
        .order_by(InactivityAlert.started_at.desc())
    ).first()


def handle_event(db: Session, user: User, event_type: str, session_id: int | None) -> None:
    threshold_min = get_app_settings(db).inactivity_alert_minutes
    threshold = timedelta(minutes=threshold_min)
    now = utcnow()

    if event_type == "user_idle":
        if threshold_min > 0 and not _open_alert(db, user.id, "idle"):
            db.add(
                InactivityAlert(
                    user_id=user.id, session_id=session_id, kind="idle",
                    started_at=now - threshold, detected_at=now,
                )
            )
    elif event_type == "user_active":
        if alert := _open_alert(db, user.id, "idle"):
            alert.ended_at = now
    elif event_type == "screen_locked":
        if threshold_min > 0 and not _open_alert(db, user.id, "locked"):
            db.add(
                InactivityAlert(
                    user_id=user.id, session_id=session_id, kind="locked",
                    started_at=now, detected_at=now + threshold,
                )
            )
    elif event_type == "screen_unlocked":
        if alert := _open_alert(db, user.id, "locked"):
            if now < alert.detected_at:
                db.delete(alert)  # short lock: never shown to admins
            else:
                alert.ended_at = now
    db.commit()


def close_open_alerts(db: Session, user_id: int) -> None:
    now = utcnow()
    for alert in db.scalars(
        select(InactivityAlert).where(InactivityAlert.user_id == user_id, InactivityAlert.ended_at.is_(None))
    ):
        if now < alert.detected_at:
            db.delete(alert)
        else:
            alert.ended_at = now
    db.commit()
