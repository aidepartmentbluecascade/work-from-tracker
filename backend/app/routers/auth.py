from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..schemas import TokenOut, UserOut
from ..security import create_access_token, verify_password
from ..serializers import user_to_out

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_opts():
    return (joinedload(User.department), selectinload(User.memberships))


def _load_user(db: Session, email: str) -> User | None:
    return db.scalars(
        select(User).options(*_user_opts()).where(func.lower(User.email) == email.lower())
    ).first()


@router.post("/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = _load_user(db, form.username)
    if user is None or not verify_password(form.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is disabled")
    return TokenOut(access_token=create_access_token(user.id, user.role.value), user=user_to_out(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    loaded = db.scalars(select(User).options(*_user_opts()).where(User.id == user.id)).first()
    return user_to_out(loaded or user)
