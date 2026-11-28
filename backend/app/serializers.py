"""Shared response builders."""

from .models import Role, User
from .schemas import UserOut


def _dept_lists(user: User) -> tuple[list[int], list[str]]:
    if user.role == Role.admin:
        return [], []
    if user.role == Role.team_lead:
        if user.department:
            return [user.department.id], [user.department.name]
        if user.department_id is not None:
            return [user.department_id], []
        return [], []
    # Employees: memberships (many). Fall back to home department_id for legacy rows.
    depts = sorted(user.memberships, key=lambda d: d.name.lower())
    if not depts and user.department:
        depts = [user.department]
    return [d.id for d in depts], [d.name for d in depts]


def user_to_out(user: User) -> UserOut:
    ids, names = _dept_lists(user)
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        timezone=user.timezone,
        tracking_enabled=user.tracking_enabled,
        screenshot_interval_minutes=user.screenshot_interval_minutes,
        department_id=ids[0] if ids else None,
        department_name=", ".join(names) if names else None,
        department_ids=ids,
        department_names=names,
        created_at=user.created_at,
    )
