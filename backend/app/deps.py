import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .database import get_db
from .models import Role, User
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


def assert_can_manage_user(actor: User, target: User) -> None:
    """Admin can manage anyone. Team leads can only manage employees in their department."""
    if actor.role == Role.admin:
        return
    if actor.role != Role.team_lead:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    if target.role != Role.user or target.department_id != actor.department_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed for this user")


def assert_can_view_user(actor: User, target: User) -> None:
    """Admin can view anyone. Team leads can view anyone in their department (employees + themselves)."""
    if actor.role == Role.admin:
        return
    if actor.role != Role.team_lead:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    if target.department_id != actor.department_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed for this user")
