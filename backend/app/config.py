import os
import re

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/wfh"
    # All app tables live in this Postgres schema, so the app can share a database safely.
    db_schema: str = "wfh"

    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720

    gcs_bucket: str = ""
    gcs_project_id: str | None = None
    # Either the full service-account JSON (best for Render / hosted env vars) ...
    google_credentials_json: str | None = None
    # ... or a path to the JSON key file.
    google_application_credentials: str | None = None
    gcs_signed_url_minutes: int = 30

    cors_origins: str = "http://localhost:5173"
    max_upload_mb: int = 10

    # A session with no heartbeat for this long is treated as ended.
    heartbeat_timeout_minutes: int = 5

    first_admin_email: str | None = None
    first_admin_password: str | None = None
    first_admin_name: str = "Administrator"

    @field_validator("database_url")
    @classmethod
    def use_psycopg_driver(cls, v: str) -> str:
        # Render and most hosts give postgres:// or postgresql:// — SQLAlchemy needs the driver name.
        return re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", v)

    @field_validator("db_schema")
    @classmethod
    def safe_schema(cls, v: str) -> str:
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", v):
            raise ValueError("DB_SCHEMA must be lowercase letters, digits and underscores")
        return v

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

# The Google client library reads this env var directly; make sure a value from .env reaches it.
if settings.google_application_credentials and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = settings.google_application_credentials
