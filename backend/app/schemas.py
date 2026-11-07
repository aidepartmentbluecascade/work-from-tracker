from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import Role
from .timeline import is_valid_timezone


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- auth / users ----------

class UserOut(ORM):
    id: int
    email: EmailStr
    full_name: str
    role: Role
    is_active: bool
    timezone: str
    tracking_enabled: bool
    screenshot_interval_minutes: int | None
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


def _check_tz(v: str | None) -> str | None:
    if v is not None and not is_valid_timezone(v):
        raise ValueError(f"Unknown timezone: {v}")
    return v


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    role: Role = Role.user
    timezone: str = "UTC"
    tracking_enabled: bool = True
    screenshot_interval_minutes: int | None = Field(default=None, ge=1, le=240)

    check_tz = field_validator("timezone")(_check_tz)


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=255)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: Role | None = None
    is_active: bool | None = None
    timezone: str | None = None
    tracking_enabled: bool | None = None
    # Send null explicitly to clear the override and use the global interval.
    screenshot_interval_minutes: int | None = Field(default=None, ge=1, le=240)

    check_tz = field_validator("timezone")(_check_tz)


# ---------- timeline ----------

class ScheduleWindow(ORM):
    weekday: int = Field(ge=0, le=6, description="0 = Monday ... 6 = Sunday")
    start_time: time
    end_time: time

    @field_validator("end_time")
    @classmethod
    def not_empty(cls, v: time, info):
        if info.data.get("start_time") == v:
            raise ValueError("start_time and end_time must differ")
        return v


class ScheduleUpdate(BaseModel):
    windows: list[ScheduleWindow] = Field(max_length=50)


# ---------- settings ----------

class AppSettingsOut(ORM):
    screenshot_interval_minutes: int
    screenshot_jitter_percent: int
    location_interval_minutes: int
    late_grace_minutes: int
    inactivity_alert_minutes: int


class AppSettingsUpdate(BaseModel):
    screenshot_interval_minutes: int | None = Field(default=None, ge=1, le=240)
    screenshot_jitter_percent: int | None = Field(default=None, ge=0, le=50)
    location_interval_minutes: int | None = Field(default=None, ge=1, le=240)
    late_grace_minutes: int | None = Field(default=None, ge=0, le=240)
    inactivity_alert_minutes: int | None = Field(default=None, ge=0, le=240)  # 0 turns alerts off


class AttendanceRow(BaseModel):
    user_id: int
    full_name: str
    email: str
    timezone: str
    day: date  # the user's local calendar day
    expected_start: datetime | None
    expected_end: datetime | None
    first_start: datetime | None
    worked_seconds: float
    # on_time | late | upcoming | not_started | absent | day_off | worked_day_off | no_schedule
    status: str
    late_minutes: int
    is_working: bool


# ---------- tracking ----------

class TrackingConfig(BaseModel):
    tracking_enabled: bool
    within_schedule: bool
    screenshot_interval_minutes: int
    screenshot_jitter_percent: int
    location_interval_minutes: int
    inactivity_alert_minutes: int
    timezone: str
    schedule: list[ScheduleWindow]
    active_session_id: int | None


class SessionOut(ORM):
    id: int
    user_id: int
    started_at: datetime
    last_heartbeat_at: datetime
    ended_at: datetime | None
    end_reason: str | None


class HeartbeatOut(BaseModel):
    session_active: bool
    end_reason: str | None
    config: TrackingConfig


class StopSession(BaseModel):
    reason: str = Field(default="manual", max_length=50)


class LocationIn(BaseModel):
    session_id: int
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0)


class LocationOut(ORM):
    id: int
    session_id: int
    captured_at: datetime
    latitude: float
    longitude: float
    accuracy_m: float | None


class EventIn(BaseModel):
    session_id: int | None = None
    event_type: str = Field(min_length=1, max_length=50)
    detail: str | None = Field(default=None, max_length=2000)


class EventOut(ORM):
    id: int
    session_id: int | None
    event_type: str
    detail: str | None
    created_at: datetime


class ScreenshotOut(ORM):
    id: int
    session_id: int
    captured_at: datetime
    gcs_uri: str
    size_bytes: int
    width: int | None
    height: int | None
    url: str | None = None  # signed HTTPS link, filled in on read


class MyStats(BaseModel):
    seconds_today: float
    seconds_this_week: float


# ---------- admin views ----------

class LiveUser(BaseModel):
    user: UserOut
    session: SessionOut
    within_schedule: bool
    last_location: LocationOut | None
    last_screenshot: ScreenshotOut | None
    inactive_since: datetime | None = None
    inactive_kind: str | None = None


class AlertOut(BaseModel):
    id: int
    user_id: int
    full_name: str
    email: str
    timezone: str
    kind: str
    started_at: datetime
    detected_at: datetime
    ended_at: datetime | None
    read_at: datetime | None
    duration_seconds: float


class AlertsOut(BaseModel):
    unread: int
    items: list[AlertOut]


class HoursRow(BaseModel):
    user_id: int
    full_name: str
    email: str
    seconds: float
    sessions: int
