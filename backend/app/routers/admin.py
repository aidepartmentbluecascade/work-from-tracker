"""Manager endpoints: users, departments, timelines, settings, screenshots, locations, reports.

Admin sees everything. Team leads are scoped to their own department.
"""

from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session, joinedload, selectinload

from .. import storage
from ..database import get_db
from ..deps import (
    assert_can_manage_user,
    assert_can_view_user,
    department_filter,
    in_department_clause,
    require_admin,
    require_manager,
)
from ..models import (
    ActivityEvent,
    Department,
    InactivityAlert,
    LocationPing,
    Role,
    Screenshot,
    User,
    WorkSchedule,
    WorkSession,
    department_memberships,
)
from ..schemas import (
    AlertOut,
    AlertsOut,
    AttendanceRow,
    AppSettingsOut,
    AppSettingsUpdate,
    DepartmentCreate,
    DepartmentMembersUpdate,
    DepartmentOut,
    DepartmentUpdate,
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
from ..serializers import user_to_out
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

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_manager)])


def _user_load_options():
    return (joinedload(User.department), selectinload(User.memberships))


def _user_or_404(db: Session, user_id: int) -> User:
    user = db.scalars(select(User).options(*_user_load_options()).where(User.id == user_id)).first()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


def _dept_or_404(db: Session, department_id: int) -> Department:
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found")
    return dept


def _with_url(shot: Screenshot) -> ScreenshotOut:
    out = ScreenshotOut.model_validate(shot)
    try:
        out.url = storage.signed_url(shot.gcs_object)
    except Exception:
        out.url = None
    return out


def _validate_role_department(role: Role, department_id: int | None) -> None:
    if role == Role.admin:
        if department_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Admins cannot belong to a department")
    elif department_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Team leads and employees must belong to a department")


def _sync_employee_home(user: User) -> None:
    """Keep users.department_id as a primary display dept for employees (from memberships)."""
    if user.role != Role.user:
        return
    ids = {d.id for d in user.memberships}
    if user.department_id in ids:
        return
    user.department_id = sorted(ids)[0] if ids else None


def _add_employee_membership(db: Session, user: User, department_id: int) -> None:
    dept = _dept_or_404(db, department_id)
    if dept not in user.memberships:
        user.memberships.append(dept)
    _sync_employee_home(user)


def _department_out(db: Session, dept: Department) -> DepartmentOut:
    member_count = db.scalar(
        select(func.count())
        .select_from(department_memberships)
        .join(User, User.id == department_memberships.c.user_id)
        .where(department_memberships.c.department_id == dept.id, User.role == Role.user)
    ) or 0
    team_lead_count = db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.department_id == dept.id, User.role == Role.team_lead)
    ) or 0
    return DepartmentOut(
        id=dept.id,
        name=dept.name,
        is_active=dept.is_active,
        created_at=dept.created_at,
        member_count=member_count,
        team_lead_count=team_lead_count,
    )


# ---------- departments (admin only) ----------

@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    q = select(Department).order_by(Department.name)
    # Leads can see their own department (for display); admins see all.
    scope = department_filter(actor)
    if scope is not None:
        q = q.where(Department.id == scope)
    return [_department_out(db, d) for d in db.scalars(q).all()]


@router.post("/departments", response_model=DepartmentOut, status_code=status.HTTP_201_CREATED)
def create_department(body: DepartmentCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    name = body.name.strip()
    exists = db.scalars(select(Department).where(func.lower(Department.name) == name.lower())).first()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "A department with this name already exists")
    dept = Department(name=name)
    db.add(dept)
    db.commit()
    db.refresh(dept)
    return _department_out(db, dept)


@router.patch("/departments/{department_id}", response_model=DepartmentOut)
def update_department(
    department_id: int,
    body: DepartmentUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    dept = _dept_or_404(db, department_id)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        name = data["name"].strip()
        clash = db.scalars(
            select(Department).where(func.lower(Department.name) == name.lower(), Department.id != dept.id)
        ).first()
        if clash:
            raise HTTPException(status.HTTP_409_CONFLICT, "A department with this name already exists")
        dept.name = name
    if "is_active" in data and data["is_active"] is not None:
        dept.is_active = data["is_active"]
    db.commit()
    db.refresh(dept)
    return _department_out(db, dept)


@router.put("/departments/{department_id}/members", response_model=DepartmentOut)
def set_department_members(
    department_id: int,
    body: DepartmentMembersUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Set which employees belong to this department (visible to its team leads).

    Employees may belong to multiple departments. Omitting someone only removes them
    from *this* department; their other memberships stay. Team leads are unchanged.
    """
    dept = _dept_or_404(db, department_id)
    wanted = list(dict.fromkeys(body.user_ids))  # unique, keep order
    wanted_set = set(wanted)

    if wanted:
        found = db.scalars(
            select(User).options(selectinload(User.memberships)).where(User.id.in_(wanted))
        ).all()
        by_id = {u.id: u for u in found}
        missing = [uid for uid in wanted if uid not in by_id]
        if missing:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"User(s) not found: {missing}")
        for u in found:
            if u.role != Role.user:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"{u.full_name} is a {u.role.value.replace('_', ' ')}, not an employee",
                )

    # Remove memberships for employees no longer selected for this department.
    current_ids = set(
        db.scalars(
            select(department_memberships.c.user_id).where(
                department_memberships.c.department_id == dept.id
            )
        ).all()
    )
    remove_ids = current_ids - wanted_set
    if remove_ids:
        db.execute(
            delete(department_memberships).where(
                department_memberships.c.department_id == dept.id,
                department_memberships.c.user_id.in_(remove_ids),
            )
        )
        for u in db.scalars(
            select(User).options(selectinload(User.memberships)).where(User.id.in_(remove_ids))
        ).all():
            u.memberships = [d for d in u.memberships if d.id != dept.id]
            _sync_employee_home(u)

    # Add memberships for newly selected employees (keep their other departments).
    add_ids = wanted_set - current_ids
    if add_ids:
        for u in db.scalars(
            select(User).options(selectinload(User.memberships)).where(User.id.in_(add_ids))
        ).all():
            if dept not in u.memberships:
                u.memberships.append(dept)
            _sync_employee_home(u)

    db.commit()
    return _department_out(db, dept)


# ---------- users ----------

@router.get("/users", response_model=list[UserOut])
def list_users(
    department_id: int | None = None,
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    q = select(User).options(*_user_load_options()).order_by(User.full_name)
    scope = department_filter(actor)
    if scope is not None:
        q = q.where(in_department_clause(scope))
    elif department_id is not None:
        q = q.where(in_department_clause(department_id))
    return [user_to_out(u) for u in db.scalars(q).unique().all()]


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    exists = db.scalars(select(User).where(func.lower(User.email) == body.email.lower())).first()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")

    role = body.role
    department_id = body.department_id

    if actor.role == Role.team_lead:
        # Leads can only create employees in their own department.
        role = Role.user
        department_id = actor.department_id
    else:
        _validate_role_department(role, department_id)
        if department_id is not None:
            dept = _dept_or_404(db, department_id)
            if not dept.is_active:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Department is inactive")

    user = User(
        email=body.email.lower(),
        full_name=body.full_name,
        password_hash=hash_password(body.password),
        role=role,
        timezone=body.timezone,
        tracking_enabled=body.tracking_enabled if role == Role.user else False if role == Role.admin else body.tracking_enabled,
        screenshot_interval_minutes=body.screenshot_interval_minutes,
        department_id=None if role == Role.admin else department_id,
    )
    if role == Role.admin:
        user.tracking_enabled = False
    db.add(user)
    db.flush()
    if role == Role.user and department_id is not None:
        _add_employee_membership(db, user, department_id)
    db.commit()
    return user_to_out(_user_or_404(db, user.id))


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    user = _user_or_404(db, user_id)
    assert_can_view_user(actor, user, db)
    return user_to_out(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    user = _user_or_404(db, user_id)
    assert_can_manage_user(actor, user, db)
    data = body.model_dump(exclude_unset=True)
    prev_role = user.role

    if actor.role == Role.team_lead:
        # Leads cannot change role or department.
        data.pop("role", None)
        data.pop("department_id", None)
    else:
        if user.id == actor.id and (data.get("is_active") is False or data.get("role") in (Role.user, Role.team_lead)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot disable or demote your own account")
        next_role = data.get("role", user.role)
        if "department_id" in data:
            next_dept = data["department_id"]
        else:
            next_dept = user.department_id
        # When role changes to admin, clear department.
        if next_role == Role.admin:
            data["department_id"] = None
            next_dept = None
        if "role" in data or "department_id" in data:
            _validate_role_department(next_role, next_dept)
        if data.get("department_id") is not None:
            dept = _dept_or_404(db, data["department_id"])
            if not dept.is_active:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Department is inactive")

    dept_provided = "department_id" in data
    new_dept = data.pop("department_id", None) if dept_provided else None
    if "password" in data:
        user.password_hash = hash_password(data.pop("password"))
    for key, value in data.items():
        if value is None and key not in ("screenshot_interval_minutes",):
            continue
        setattr(user, key, value)

    if user.role == Role.admin:
        user.department_id = None
        user.memberships = []
        user.tracking_enabled = False
    elif user.role == Role.team_lead:
        # Team leads use a single home department; clear multi-memberships.
        user.memberships = []
        if dept_provided and new_dept is not None:
            user.department_id = new_dept
    elif user.role == Role.user:
        if dept_provided and new_dept is not None:
            # User form adds membership without removing other departments.
            _add_employee_membership(db, user, new_dept)
        elif prev_role != Role.user and user.department_id is not None:
            # Demoted to employee: convert home dept into a membership.
            _add_employee_membership(db, user, user.department_id)
        _sync_employee_home(user)

    db.commit()
    return user_to_out(_user_or_404(db, user.id))


@router.delete("/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    """Permanently delete a user, all their tracking data, and their screenshots in GCS."""
    user = _user_or_404(db, user_id)
    assert_can_manage_user(actor, user, db)
    if user.id == actor.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete your own account")
    if user.role == Role.admin:
        if actor.role != Role.admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed for this user")
        admins = db.scalar(select(func.count()).select_from(User).where(User.role == Role.admin))
        if admins <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete the last admin")
    if user.role == Role.team_lead and actor.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed for this user")

    try:
        deleted_images = storage.delete_user_screenshots(user.id)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Could not delete screenshots from storage: {exc}") from exc

    db.delete(user)
    db.commit()
    return {"deleted": True, "screenshots_deleted": deleted_images}


# ---------- timeline (work schedule) ----------

@router.get("/users/{user_id}/schedule", response_model=list[ScheduleWindow])
def get_schedule(user_id: int, db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    user = _user_or_404(db, user_id)
    assert_can_view_user(actor, user, db)
    return user.schedules


@router.put("/users/{user_id}/schedule", response_model=list[ScheduleWindow])
def set_schedule(
    user_id: int,
    body: ScheduleUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    user = _user_or_404(db, user_id)
    assert_can_manage_user(actor, user, db)
    user.schedules = [
        WorkSchedule(weekday=w.weekday, start_time=w.start_time, end_time=w.end_time) for w in body.windows
    ]
    db.commit()
    db.refresh(user)
    return user.schedules


# ---------- global settings (admin only) ----------

@router.get("/settings", response_model=AppSettingsOut)
def get_settings(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return get_app_settings(db)


@router.patch("/settings", response_model=AppSettingsOut)
def update_settings(body: AppSettingsUpdate, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    s = get_app_settings(db)
    for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(s, key, value)
    db.commit()
    return s


# ---------- per-user day view ----------

def _day_range(db: Session, user_id: int, day: date, actor: User) -> tuple[User, datetime, datetime]:
    user = _user_or_404(db, user_id)
    assert_can_view_user(actor, user, db)
    start, end = local_day_bounds(day, user.timezone)
    return user, start, end


@router.get("/users/{user_id}/screenshots", response_model=list[ScreenshotOut])
def user_screenshots(
    user_id: int,
    day: date = Query(..., alias="date"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    _, start, end = _day_range(db, user_id, day, actor)
    shots = db.scalars(
        select(Screenshot)
        .where(Screenshot.user_id == user_id, Screenshot.captured_at >= start, Screenshot.captured_at < end)
        .order_by(Screenshot.captured_at)
    ).all()
    return [_with_url(s) for s in shots]


@router.get("/users/{user_id}/locations", response_model=list[LocationOut])
def user_locations(
    user_id: int,
    day: date = Query(..., alias="date"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    _, start, end = _day_range(db, user_id, day, actor)
    return db.scalars(
        select(LocationPing)
        .where(LocationPing.user_id == user_id, LocationPing.captured_at >= start, LocationPing.captured_at < end)
        .order_by(LocationPing.captured_at)
    ).all()


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
def user_sessions(
    user_id: int,
    day: date = Query(..., alias="date"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    close_stale_sessions(db)
    _, start, end = _day_range(db, user_id, day, actor)
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
def user_events(
    user_id: int,
    day: date = Query(..., alias="date"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    _, start, end = _day_range(db, user_id, day, actor)
    return db.scalars(
        select(ActivityEvent)
        .where(ActivityEvent.user_id == user_id, ActivityEvent.created_at >= start, ActivityEvent.created_at < end)
        .order_by(ActivityEvent.created_at)
    ).all()


# ---------- live + reports ----------

@router.get("/live", response_model=list[LiveUser])
def live(db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    close_stale_sessions(db)
    sessions = db.scalars(select(WorkSession).where(WorkSession.ended_at.is_(None))).all()
    scope = department_filter(actor)
    result: list[LiveUser] = []
    for s in sessions:
        user = db.scalars(
            select(User).options(*_user_load_options()).where(User.id == s.user_id)
        ).first()
        if user is None:
            continue
        if user.role != Role.user:
            continue
        if scope is not None and not any(d.id == scope for d in user.memberships) and user.department_id != scope:
            continue
        last_loc = db.scalars(
            select(LocationPing).where(LocationPing.session_id == s.id).order_by(LocationPing.captured_at.desc())
        ).first()
        last_shot = db.scalars(
            select(Screenshot).where(Screenshot.session_id == s.id).order_by(Screenshot.captured_at.desc())
        ).first()
        inactive = db.scalars(
            select(InactivityAlert)
            .where(
                InactivityAlert.user_id == user.id,
                InactivityAlert.ended_at.is_(None),
                InactivityAlert.detected_at <= utcnow(),
            )
            .order_by(InactivityAlert.started_at)
        ).first()
        result.append(
            LiveUser(
                user=user_to_out(user),
                session=SessionOut.model_validate(s),
                within_schedule=within_schedule(user.schedules, user.timezone),
                last_location=LocationOut.model_validate(last_loc) if last_loc else None,
                last_screenshot=_with_url(last_shot) if last_shot else None,
                inactive_since=inactive.started_at if inactive else None,
                inactive_kind=inactive.kind if inactive else None,
            )
        )
    result.sort(key=lambda r: r.user.full_name)
    return result


@router.get("/alerts", response_model=AlertsOut)
def list_alerts(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    now = utcnow()
    visible = InactivityAlert.detected_at <= now
    q = (
        select(InactivityAlert, User)
        .join(User, User.id == InactivityAlert.user_id)
        .options(*_user_load_options())
        .where(visible)
        .order_by(InactivityAlert.detected_at.desc())
        .limit(limit)
    )
    scope = department_filter(actor)
    if scope is not None:
        q = q.where(in_department_clause(scope))
    rows = db.execute(q).unique().all()

    unread_q = (
        select(func.count())
        .select_from(InactivityAlert)
        .join(User, User.id == InactivityAlert.user_id)
        .where(visible, InactivityAlert.read_at.is_(None))
    )
    if scope is not None:
        unread_q = unread_q.where(in_department_clause(scope))
    unread = db.scalar(unread_q)

    items: list[AlertOut] = []
    for a, u in rows:
        out = user_to_out(u)
        items.append(
            AlertOut(
                id=a.id,
                user_id=u.id,
                full_name=u.full_name,
                email=u.email,
                timezone=u.timezone,
                department_id=out.department_id,
                department_name=out.department_name,
                kind=a.kind,
                started_at=a.started_at,
                detected_at=a.detected_at,
                ended_at=a.ended_at,
                read_at=a.read_at,
                duration_seconds=((a.ended_at or now) - a.started_at).total_seconds(),
            )
        )
    return AlertsOut(unread=unread or 0, items=items)


@router.post("/alerts/read-all")
def mark_alerts_read(db: Session = Depends(get_db), actor: User = Depends(require_manager)):
    now = utcnow()
    scope = department_filter(actor)
    if scope is None:
        db.execute(
            update(InactivityAlert)
            .where(InactivityAlert.read_at.is_(None), InactivityAlert.detected_at <= now)
            .values(read_at=now)
        )
    else:
        # Only mark alerts for users in this department (home or membership).
        user_ids = select(User.id).where(in_department_clause(scope))
        db.execute(
            update(InactivityAlert)
            .where(
                InactivityAlert.read_at.is_(None),
                InactivityAlert.detected_at <= now,
                InactivityAlert.user_id.in_(user_ids),
            )
            .values(read_at=now)
        )
    db.commit()
    return {"ok": True}


EARLY_START_WINDOW = timedelta(hours=4)  # a session up to 4h before the expected start still counts for that day


def _attendance_for(db: Session, user: User, day: date, grace: timedelta, now: datetime) -> AttendanceRow:
    day_start, day_end = local_day_bounds(day, user.timezone)
    window = expected_window(user.schedules, day, user.timezone)

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

    out = user_to_out(user)
    return AttendanceRow(
        user_id=user.id,
        full_name=user.full_name,
        email=user.email,
        timezone=user.timezone,
        department_id=out.department_id,
        department_name=out.department_name,
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
    actor: User = Depends(require_manager),
):
    close_stale_sessions(db)
    grace = timedelta(minutes=get_app_settings(db).late_grace_minutes)
    now = utcnow()
    scope = department_filter(actor)

    if user_id is not None:
        user = _user_or_404(db, user_id)
        assert_can_view_user(actor, user, db)
        users = [user]
    else:
        q = (
            select(User)
            .options(*_user_load_options())
            .where(User.role == Role.user, User.is_active.is_(True))
            .order_by(User.full_name)
        )
        if scope is not None:
            q = q.where(in_department_clause(scope))
        users = list(db.scalars(q).unique().all())

    rows = []
    for user in users:
        user_day = day or now.astimezone(get_zone(user.timezone)).date()
        rows.append(_attendance_for(db, user, user_day, grace, now))
    return rows


@router.get("/reports/hours", response_model=list[HoursRow])
def hours_report(
    start: date = Query(..., description="First day (UTC), inclusive"),
    end: date = Query(..., description="Last day (UTC), inclusive"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_manager),
):
    if end < start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "end must be on or after start")
    close_stale_sessions(db)
    range_start = datetime.combine(start, time.min, tzinfo=timezone.utc)
    range_end = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc)
    scope = department_filter(actor)

    users_q = (
        select(User)
        .options(*_user_load_options())
        .where(User.role == Role.user)
        .order_by(User.full_name)
    )
    if scope is not None:
        users_q = users_q.where(in_department_clause(scope))
    users = list(db.scalars(users_q).unique().all())
    user_ids = {u.id for u in users}

    sessions = db.scalars(
        select(WorkSession).where(
            WorkSession.started_at < range_end,
            (WorkSession.ended_at.is_(None)) | (WorkSession.ended_at > range_start),
        )
    ).all()
    totals: dict[int, list[float]] = {}
    for s in sessions:
        if s.user_id not in user_ids:
            continue
        secs = session_seconds_in_range(s, range_start, range_end)
        row = totals.setdefault(s.user_id, [0.0, 0])
        row[0] += secs
        row[1] += 1

    result: list[HoursRow] = []
    for u in users:
        out = user_to_out(u)
        result.append(
            HoursRow(
                user_id=u.id,
                full_name=u.full_name,
                email=u.email,
                department_id=out.department_id,
                department_name=out.department_name,
                seconds=totals.get(u.id, [0.0, 0])[0],
                sessions=int(totals.get(u.id, [0.0, 0])[1]),
            )
        )
    return result
