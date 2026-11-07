"""Google Cloud Storage helpers for screenshots.

The bucket stays private. We store the object path and gs:// link in Postgres and hand
admins short-lived signed HTTPS URLs when they view screenshots.
"""

import json
import uuid
from datetime import datetime, timedelta

from google.cloud import storage
from google.oauth2 import service_account

from .config import settings

_client: storage.Client | None = None

EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def _make_client() -> storage.Client:
    if settings.google_credentials_json:
        info = json.loads(settings.google_credentials_json)
        creds = service_account.Credentials.from_service_account_info(info)
        return storage.Client(project=settings.gcs_project_id or info.get("project_id"), credentials=creds)
    # Falls back to GOOGLE_APPLICATION_CREDENTIALS (key file) or default credentials.
    return storage.Client(project=settings.gcs_project_id)


def _bucket() -> storage.Bucket:
    global _client
    if not settings.gcs_bucket:
        raise RuntimeError("GCS_BUCKET is not configured")
    if _client is None:
        _client = _make_client()
    return _client.bucket(settings.gcs_bucket)


def upload_screenshot(user_id: int, captured_at: datetime, data: bytes, content_type: str) -> tuple[str, str]:
    """Upload image bytes; returns (object_name, gs_uri)."""
    ext = EXTENSIONS[content_type]
    object_name = (
        f"screenshots/user_{user_id}/{captured_at:%Y/%m/%d}/"
        f"{captured_at:%H%M%S}_{uuid.uuid4().hex[:8]}.{ext}"
    )
    blob = _bucket().blob(object_name)
    blob.upload_from_string(data, content_type=content_type)
    return object_name, f"gs://{settings.gcs_bucket}/{object_name}"


def delete_user_screenshots(user_id: int) -> int:
    """Delete every screenshot object stored for a user. Returns the number deleted."""
    bucket = _bucket()
    blobs = list(bucket.list_blobs(prefix=f"screenshots/user_{user_id}/"))
    for i in range(0, len(blobs), 100):
        bucket.delete_blobs(blobs[i : i + 100], on_error=lambda blob: None)  # ignore already-missing objects
    return len(blobs)


def signed_url(object_name: str) -> str:
    blob = _bucket().blob(object_name)
    return blob.generate_signed_url(
        version="v4",
        expiration=timedelta(minutes=settings.gcs_signed_url_minutes),
        method="GET",
    )
