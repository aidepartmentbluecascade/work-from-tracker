from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text

from .config import settings
from .database import Base, SessionLocal, engine, ensure_schema
from .models import Role, User
from .routers import admin, auth, tracking
from .security import hash_password
from .timeline import get_app_settings


def init_db() -> None:
    # For production schema changes, switch to Alembic migrations.
    ensure_schema()
    Base.metadata.create_all(bind=engine)
    # Lightweight upgrades for tables created by earlier versions (create_all never adds columns).
    with engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS late_grace_minutes INTEGER NOT NULL DEFAULT 10")
        )
    with SessionLocal() as db:
        get_app_settings(db)
        has_admin = db.scalars(select(User).where(User.role == Role.admin)).first()
        if not has_admin and settings.first_admin_email and settings.first_admin_password:
            db.add(
                User(
                    email=settings.first_admin_email.lower(),
                    full_name=settings.first_admin_name,
                    password_hash=hash_password(settings.first_admin_password),
                    role=Role.admin,
                    tracking_enabled=False,
                )
            )
            db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Work From Home Tracker", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(tracking.router)
app.include_router(admin.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
