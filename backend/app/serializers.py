"""Shared response builders."""

from .models import User
from .schemas import UserOut


def user_to_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        timezone=user.timezone,
        tracking_enabled=user.tracking_enabled,
        screenshot_interval_minutes=user.screenshot_interval_minutes,
        department_id=user.department_id,
        department_name=user.department.name if user.department else None,
        created_at=user.created_at,
    )
