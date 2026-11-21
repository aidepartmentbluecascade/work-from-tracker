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


def _upgrade_schema() -> None:
    """Lightweight upgrades for tables created by earlier versions (create_all never alters)."""
    with engine.begin() as conn:
        for column in ("late_grace_minutes", "inactivity_alert_minutes"):
            conn.execute(
                text(f"ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS {column} INTEGER NOT NULL DEFAULT 10")
            )
        # Add team_lead to the Postgres enum if it is missing (safe to re-run).
        conn.execute(
            text(
                """
                DO $$ BEGIN
                    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'team_lead';
                EXCEPTION
                    WHEN duplicate_object THEN null;
                    WHEN undefined_object THEN null;
                END $$;
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS departments (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) NOT NULL UNIQUE,
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id INTEGER"))
        # FK may already exist; ignore if it does.
        conn.execute(
            text(
                """
                DO $$ BEGIN
                    ALTER TABLE users
                        ADD CONSTRAINT users_department_id_fkey
                        FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
                EXCEPTION
                    WHEN duplicate_object THEN null;
                END $$;
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_department_id ON users (department_id)"))


def init_db() -> None:
    # For production schema changes, switch to Alembic migrations.
    ensure_schema()
    Base.metadata.create_all(bind=engine)
    _upgrade_schema()
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
