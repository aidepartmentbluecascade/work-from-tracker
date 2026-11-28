import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from .database import get_db
from .models import Role, User, department_memberships
from .security import decode_access_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != Role.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


def require_manager(user: User = Depends(get_current_user)) -> User:
    if user.role not in (Role.admin, Role.team_lead):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    return user


def department_filter(actor: User) -> int | None:
    """None = admin (no filter). Team leads are scoped to their own department."""
    if actor.role == Role.admin:
        return None
    if actor.role == Role.team_lead:
        if actor.department_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Team lead has no department assigned",
            )
        return actor.department_id
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")


def in_department_clause(department_id: int):
    """SQL filter: home department OR membership (employees can be in many departments)."""
    member_ids = select(department_memberships.c.user_id).where(
        department_memberships.c.department_id == department_id
    )
    return or_(User.department_id == department_id, User.id.in_(member_ids))


def user_in_department(user: User, department_id: int) -> bool:
    if user.department_id == department_id:
        return True
    return any(d.id == department_id for d in user.memberships)


def ensure_memberships_loaded(db: Session, user: User) -> User:
    """Reload user with memberships when needed for permission checks."""
    if "memberships" in user.__dict__:
        return user
    loaded = db.scalars(
        select(User).options(selectinload(User.memberships)).where(User.id == user.id)
    ).first()
    return loaded or user


def assert_can_manage_user(actor: User, target: User, db: Session | None = None) -> None:
    """Admin can manage anyone. Team leads can only manage employees in their department."""
    if actor.role == Role.admin:
        return
    if actor.role != Role.team_lead:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    if target.role != Role.user:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed for this user")
    if db is not None:
        target = ensure_memberships_loaded(db, target)
    if actor.department_id is None or not user_in_department(target, actor.department_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed for this user")


def assert_can_view_user(actor: User, target: User, db: Session | None = None) -> None:
    """Admin can view anyone. Team leads can view anyone in their department (employees + themselves)."""
    if actor.role == Role.admin:
        return
    if actor.role != Role.team_lead:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    if db is not None:
        target = ensure_memberships_loaded(db, target)
    if actor.department_id is None or not user_in_department(target, actor.department_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed for this user")
