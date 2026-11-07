import enum
from datetime import datetime, time

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    Time,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Role(str, enum.Enum):
    admin = "admin"
    user = "user"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role, name="user_role"), default=Role.user)
    is_active: Mapped[bool] = mapped_column(default=True)
    # IANA timezone, e.g. "Asia/Karachi". The work timeline is interpreted in this zone.
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    tracking_enabled: Mapped[bool] = mapped_column(default=True)
    # Per-user override; NULL means "use the global setting".
    screenshot_interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    schedules: Mapped[list["WorkSchedule"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="[WorkSchedule.weekday, WorkSchedule.start_time]",
    )


class AppSettings(Base):
    """Single-row table (id = 1) with global defaults set by admins."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    screenshot_interval_minutes: Mapped[int] = mapped_column(default=10)
    # Randomize each capture by +/- this percent so capture times are not predictable.
    screenshot_jitter_percent: Mapped[int] = mapped_column(default=20)
    location_interval_minutes: Mapped[int] = mapped_column(default=15)
    # Starting more than this many minutes after the expected start counts as "late".
    late_grace_minutes: Mapped[int] = mapped_column(default=10, server_default="10")


class WorkSchedule(Base):
    """One working window on a weekday (0 = Monday ... 6 = Sunday), in the user's timezone.

    If end_time < start_time the window runs overnight into the next day.
    A user with no rows has no timeline restriction.
    """

    __tablename__ = "work_schedules"
    __table_args__ = (
        CheckConstraint("weekday BETWEEN 0 AND 6", name="ck_schedule_weekday"),
        CheckConstraint("start_time <> end_time", name="ck_schedule_nonempty"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    weekday: Mapped[int] = mapped_column(SmallInteger)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)

    user: Mapped[User] = relationship(back_populates="schedules")


class WorkSession(Base):
    __tablename__ = "work_sessions"
    __table_args__ = (Index("ix_sessions_user_started", "user_id", "started_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # manual | sharing_stopped | schedule_ended | heartbeat_lost | superseded | location_denied
    end_reason: Mapped[str | None] = mapped_column(String(50), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)


class Screenshot(Base):
    __tablename__ = "screenshots"
    __table_args__ = (Index("ix_screenshots_user_captured", "user_id", "captured_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    session_id: Mapped[int] = mapped_column(ForeignKey("work_sessions.id", ondelete="CASCADE"))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Object path inside the bucket, e.g. screenshots/user_3/2026/11/07/101500_ab12cd34.jpg
    gcs_object: Mapped[str] = mapped_column(String(512))
    # Full link, e.g. gs://bucket/screenshots/...
    gcs_uri: Mapped[str] = mapped_column(String(600))
    content_type: Mapped[str] = mapped_column(String(50))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)


class LocationPing(Base):
    __tablename__ = "location_pings"
    __table_args__ = (Index("ix_locations_user_captured", "user_id", "captured_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    session_id: Mapped[int] = mapped_column(ForeignKey("work_sessions.id", ondelete="CASCADE"))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)


class ActivityEvent(Base):
    __tablename__ = "activity_events"
    __table_args__ = (Index("ix_events_user_created", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    session_id: Mapped[int | None] = mapped_column(
        ForeignKey("work_sessions.id", ondelete="CASCADE"), nullable=True
    )
    # tab_hidden | tab_visible | location_unavailable | capture_failed | ...
    event_type: Mapped[str] = mapped_column(String(50))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
