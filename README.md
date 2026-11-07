# WFH Tracker

Work-from-home tracking web app.

- **Backend:** FastAPI + SQLAlchemy + PostgreSQL
- **Frontend:** React (Vite + TypeScript)
- **Screenshots:** Google Cloud Storage (private bucket). Each user's links are stored in Postgres.

## Features

| Admin | User |
|---|---|
| Create, edit and disable users; reset passwords | Start / stop work |
| Set the screenshot interval globally and per user | Full-screen screenshots at the admin-set interval (random ±jitter) |
| Set each user's **work timeline** (weekly hours, in their timezone) | Location sent at a set interval |
| Live dashboard: who's working, last location, latest screenshot | See own hours today and this week, plus schedule |
| Per-user day view: sessions, screenshots, location map, events | Notice listing exactly what is recorded |
| Hours report across users | |

**How the timeline works:** the timeline is each user's expected working hours, and it's for information only. Users can start work at any time (late, early or extra hours) and are tracked whenever they work. Overnight windows (for example 22:00–06:00) are supported.

**How capture works (browser):** when the user clicks *Start work*, the browser asks for location and asks which screen to share. The user must pick **Entire screen**; the app rejects a single window or tab. The tab has to stay open (it can be minimized). If the user clicks "Stop sharing" or closes the tab, the session ends and the reason is recorded.

## Project layout

```
backend/
  app/
    main.py          app + startup (creates tables, first admin)
    models.py        users, app_settings, work_schedules, work_sessions,
                     screenshots, location_pings, activity_events
    timeline.py      schedule checks, timezone day ranges, stale-session cleanup
    storage.py       GCS upload + signed URLs
    routers/auth.py      /api/auth/login, /api/auth/me
    routers/tracking.py  /api/tracking/*  (used by the employee's browser)
    routers/admin.py     /api/admin/*     (admin only)
    create_admin.py  CLI to create/reset an admin
frontend/
  src/tracker.ts     screen capture, location, heartbeat logic
  src/pages/         Login, UserHome, admin/*
docker-compose.yml   local Postgres
```

## 1. Google Cloud Storage setup

1. Create a bucket, for example `yourco-wfh-screenshots`, with **public access prevention** turned on.
2. Create a service account and give it **Storage Object Admin** on that bucket only.
3. Create a JSON key for the service account and save it outside the repo.
4. Optional: add a lifecycle rule to delete objects after N days (retention).

Screenshots are stored at `screenshots/user_<id>/YYYY/MM/DD/HHMMSS_xxxx.jpg`. The `screenshots` table saves the `gs://` link and the object path for each user. When an admin views screenshots, the API returns short-lived signed HTTPS links (`GCS_SIGNED_URL_MINUTES`).

## 2. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # then edit DATABASE_URL, JWT_SECRET, GCS_BUCKET, GOOGLE_APPLICATION_CREDENTIALS, FIRST_ADMIN_*
uvicorn app.main:app --reload --port 8000
```

On first start, the tables are created, along with the admin from `FIRST_ADMIN_EMAIL` / `FIRST_ADMIN_PASSWORD`.
To create or reset an admin at any time: `python -m app.create_admin you@company.com "StrongPass123" "Your Name"`.

API docs: http://127.0.0.1:8000/docs

Local Postgres (requires Docker Desktop to be running): `docker compose up -d` from the project root.

## 3. Frontend

```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173  (proxies /api to :8000)
```

For production, run `npm run build` and serve `frontend/dist`. Set `VITE_API_URL` to the backend URL before building, and add the frontend URL to `CORS_ORIGINS`.

## Deploying on Render

`render.yaml` defines two services: **wfh-tracker-api** (FastAPI) and **wfh-tracker** (static React site).

1. Push the repo to GitHub. Check that `backend/.env` is **not** committed; it's already in `.gitignore`.
2. In Render, go to **New → Blueprint** and select the repo.
3. Fill in the prompted values:
   - `DATABASE_URL`: use the database's **Internal** URL if the database and API are in the same Render region (Oregon); otherwise use the External URL.
   - `GOOGLE_CREDENTIALS_JSON`: paste the raw JSON with no surrounding quotes.
   - `FIRST_ADMIN_*`: only used if no admin exists yet.
   - `CORS_ORIGINS` and `VITE_API_URL`: leave these until the first deploy gives you both `.onrender.com` URLs. Then set `CORS_ORIGINS` = frontend URL on the API, and `VITE_API_URL` = API URL on the static site. Redeploy the static site, because Vite bakes the URL in at build time.
4. Render provides HTTPS, which screen capture and location require.

The free web-service plan sleeps after about 15 minutes idle. Use a paid instance for real use, otherwise heartbeats will be slow after it wakes.

## Production notes

- **HTTPS is required.** Browsers only allow screen capture and geolocation on HTTPS (or localhost).
- Use a long random `JWT_SECRET`.
- The schema is created with `create_all`. Switch to Alembic before making schema changes on a live database.
- Desktop location comes from Wi‑Fi or IP unless the device has GPS. Every point stores `accuracy_m`.
- Tell employees in writing what is collected, and set a retention period. Depending on where you operate, privacy laws such as GDPR may require this.
- A desktop agent (for example Electron) can be added later for silent capture without a browser tab. It would use the same `/api/tracking/*` endpoints.
