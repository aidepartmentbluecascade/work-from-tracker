/**
 * Browser-side tracker.
 *
 * - Asks the user to share their ENTIRE screen once (getDisplayMedia).
 * - Grabs a frame every N minutes (admin setting, with random jitter) and uploads it;
 *   black frames (locked / sleeping screen) are skipped.
 * - Sends geolocation every M minutes and a heartbeat every minute.
 * - Pauses automatically while the screen is locked (Idle Detection API, Chrome/Edge) and
 *   resumes on unlock. If the server ended the session because the computer slept, it opens
 *   a new session automatically, so the employee never has to restart by hand.
 */
import { api, ApiError } from "./api";
import { END_REASONS } from "./format";
import type { HeartbeatResponse, TrackingConfig, WorkSession } from "./types";

export interface TrackerStatus {
  active: boolean; // the user has started work and screen sharing is live
  paused: boolean; // temporarily not tracking (screen locked / reconnecting)
  pauseReason: string | null;
  sessionId: number | null;
  startedAt: Date | null;
  lastScreenshotAt: Date | null;
  lastLocationAt: Date | null;
  message: string | null;
}

const HEARTBEAT_MS = 60_000;
const RETRY_RESUME_MS = 30_000;
const MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.7;

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}

interface IdleDetectorLike extends EventTarget {
  readonly screenState: "locked" | "unlocked" | null;
  readonly userState: "active" | "idle" | null;
  start(opts: { threshold: number; signal: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<"granted" | "denied">;
}
const IdleDetectorCls = (window as unknown as { IdleDetector?: IdleDetectorCtor }).IdleDetector;

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 60_000,
    });
  });
}

function isPermissionDenied(err: unknown): boolean {
  return (
    typeof GeolocationPositionError !== "undefined" &&
    err instanceof GeolocationPositionError &&
    err.code === err.PERMISSION_DENIED
  );
}

/** True if the frame is (almost) entirely black — e.g. a locked or sleeping screen. */
function isBlankFrame(source: CanvasImageSource): boolean {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 36;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
    if (lum > max) max = lum;
  }
  return max < 16;
}

export class Tracker {
  private running = false;
  private paused = false;
  private resuming = false;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private imageCapture: ImageCaptureLike | null = null;
  private idleAbort: AbortController | null = null;
  private config: TrackingConfig | null = null;
  private sessionId: number | null = null;
  private blankStreak = false;
  private lockDetection = false;
  private shotTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private locationTimer: number | undefined;
  private resumeTimer: number | undefined;
  private status: TrackerStatus = {
    active: false,
    paused: false,
    pauseReason: null,
    sessionId: null,
    startedAt: null,
    lastScreenshotAt: null,
    lastLocationAt: null,
    message: null,
  };

  constructor(private onChange: (s: TrackerStatus) => void) {}

  private update(patch: Partial<TrackerStatus>) {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }

  get isActive() {
    return this.running;
  }

  /** Start work. Pass `resumeSessionId` to continue a session interrupted by a page refresh. */
  async start(resumeSessionId?: number): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("This browser can't capture the screen. Please use Chrome, Edge or Firefox on a computer.");
    }

    // Must happen first, while the click still counts as a user gesture.
    const lockDetection = await this.requestLockDetection();

    const config = await api<TrackingConfig>("/tracking/config");
    if (!config.tracking_enabled) throw new Error("Tracking is disabled for your account. Contact your admin.");

    // 1) Location permission (required).
    let position: GeolocationPosition | null = null;
    try {
      position = await getPosition();
    } catch (err) {
      if (isPermissionDenied(err)) {
        throw new Error("Location permission is required. Allow location for this site in your browser and try again.");
      }
    }

    // 2) Screen-share permission. Must be the entire screen.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor", frameRate: 1 },
        audio: false,
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
      } as DisplayMediaStreamOptions);
    } catch {
      throw new Error("Screen sharing is required to start work. Please choose your entire screen.");
    }
    const track = stream.getVideoTracks()[0]!;
    const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    if (surface && surface !== "monitor") {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Please share your "Entire screen", not a window or tab.');
    }

    // 3) Continue the interrupted session if it's still open, otherwise open a new one.
    let session: WorkSession;
    let resumed = false;
    try {
      session = await this.openOrResume(resumeSessionId);
      resumed = resumeSessionId !== undefined && session.id === resumeSessionId;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }

    this.running = true;
    this.paused = false;
    this.stream = stream;
    this.config = config;
    this.sessionId = session.id;
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
    this.imageCapture = IC ? new IC(track) : null;

    track.addEventListener("ended", () => void this.stop("sharing_stopped"));
    document.addEventListener("visibilitychange", this.onVisibility);
    if (lockDetection) void this.startLockDetection();

    this.update({
      active: true,
      paused: false,
      pauseReason: null,
      sessionId: session.id,
      startedAt: new Date(session.started_at),
      lastScreenshotAt: null,
      lastLocationAt: null,
      message: null,
    });

    if (resumed) void this.logEvent("page_reloaded");
    if (position) void this.sendLocation(position);
    else void this.logEvent("location_unavailable", "Position unavailable at start");
    if (!lockDetection) void this.logEvent("lock_detection_unavailable");

    this.startLoops(5_000);
  }

  private async openOrResume(resumeSessionId?: number): Promise<WorkSession> {
    if (resumeSessionId !== undefined) {
      try {
        return await api<WorkSession>(`/tracking/sessions/${resumeSessionId}/resume`, { method: "POST" });
      } catch (err) {
        // 404/409: it already ended (e.g. the refresh took longer than 5 minutes) — start a new one.
        if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 409)) throw err;
      }
    }
    return api<WorkSession>("/tracking/sessions/start", { method: "POST" });
  }

  async stop(reason = "manual"): Promise<void> {
    if (!this.running) return;
    const id = this.sessionId;
    this.teardown(reason === "manual" ? "You stopped work." : END_REASONS[reason] ?? reason);
    if (id !== null) {
      await api(`/tracking/sessions/${id}/stop`, { method: "POST", body: { reason } }).catch(() => undefined);
    }
  }

  // ---------- lock detection ----------

  private async requestLockDetection(): Promise<boolean> {
    if (!IdleDetectorCls) return false;
    try {
      return (await IdleDetectorCls.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }

  /** Inactivity threshold set by admins (Settings); the browser's minimum is 1 minute. */
  private idleThresholdMs(): number {
    const minutes = this.config?.inactivity_alert_minutes || 5;
    return Math.max(1, minutes) * 60_000;
  }

  private async startLockDetection() {
    if (!IdleDetectorCls) return;
    this.idleAbort?.abort();
    this.lockDetection = true;
    try {
      const detector = new IdleDetectorCls();
      this.idleAbort = new AbortController();
      let lastUser: string | null = null;
      detector.addEventListener("change", () => {
        if (detector.screenState === "locked") {
          void this.pause("screen_locked");
        } else if (this.paused && this.status.pauseReason === "screen_locked") {
          void this.resume("screen_unlocked");
        }
        if (detector.screenState !== "locked" && detector.userState !== lastUser) {
          if (lastUser !== null) void this.logEvent(detector.userState === "idle" ? "user_idle" : "user_active");
          lastUser = detector.userState;
        }
      });
      await detector.start({ threshold: this.idleThresholdMs(), signal: this.idleAbort.signal });
    } catch {
      void this.logEvent("lock_detection_unavailable");
    }
  }

  // ---------- pause / resume ----------

  /** Stop counting time (ends the server session) but keep screen sharing alive. */
  private async pause(reason: string) {
    if (!this.running || this.paused) return;
    await this.logEvent(reason);
    this.paused = true;
    this.stopLoops();
    const id = this.sessionId;
    this.sessionId = null;
    this.update({ paused: true, pauseReason: reason, sessionId: null });
    if (id !== null) {
      await api(`/tracking/sessions/${id}/stop`, { method: "POST", body: { reason } }).catch(() => undefined);
    }
  }

  /** Open a new session and continue tracking without asking the user again. */
  private async resume(eventType: string) {
    if (!this.running || this.resuming) return;
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState === "ended") {
      this.teardown(END_REASONS.sharing_stopped ?? "Screen sharing stopped");
      return;
    }
    this.resuming = true;
    window.clearTimeout(this.resumeTimer);
    try {
      const session = await api<WorkSession>("/tracking/sessions/start", { method: "POST" });
      this.config = await api<TrackingConfig>("/tracking/config").catch(() => this.config);
      this.sessionId = session.id;
      this.paused = false;
      this.blankStreak = false;
      this.update({
        paused: false,
        pauseReason: null,
        sessionId: session.id,
        startedAt: new Date(session.started_at),
        message: null,
      });
      void this.logEvent(eventType);
      getPosition().then((p) => this.sendLocation(p)).catch(() => undefined);
      this.startLoops(10_000);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        this.teardown(err.status === 403 ? err.message : "Signed out.");
      } else {
        // Probably still offline after waking up — try again shortly.
        this.paused = true;
        this.update({ paused: true, pauseReason: "reconnecting" });
        this.resumeTimer = window.setTimeout(() => void this.resume(eventType), RETRY_RESUME_MS);
      }
    } finally {
      this.resuming = false;
    }
  }

  /** The server closed our session (e.g. the computer slept): start a fresh one. */
  private handleSessionLost() {
    if (!this.running) return;
    this.stopLoops();
    this.sessionId = null;
    this.paused = true;
    this.update({ paused: true, pauseReason: "reconnecting", sessionId: null });
    void this.resume("session_resumed");
  }

  // ---------- loops ----------

  private startLoops(firstShotDelayMs?: number) {
    this.stopLoops();
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.startLocationLoop();
    this.scheduleScreenshot(firstShotDelayMs);
  }

  private stopLoops() {
    window.clearTimeout(this.shotTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.locationTimer);
  }

  private teardown(message: string | null) {
    this.running = false;
    this.paused = false;
    this.stopLoops();
    window.clearTimeout(this.resumeTimer);
    this.idleAbort?.abort();
    this.idleAbort = null;
    this.lockDetection = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.imageCapture = null;
    this.sessionId = null;
    this.update({ active: false, paused: false, pauseReason: null, sessionId: null, message });
  }

  private onVisibility = () => {
    if (this.sessionId !== null) void this.logEvent(document.hidden ? "tab_hidden" : "tab_visible");
  };

  private scheduleScreenshot(delayMs?: number) {
    window.clearTimeout(this.shotTimer);
    if (!this.config) return;
    const base = this.config.screenshot_interval_minutes * 60_000;
    const jitter = this.config.screenshot_jitter_percent / 100;
    const delay = delayMs ?? Math.max(30_000, base * (1 + (Math.random() * 2 - 1) * jitter));
    this.shotTimer = window.setTimeout(async () => {
      await this.captureAndUpload();
      if (this.running && !this.paused) this.scheduleScreenshot();
    }, delay);
  }

  private startLocationLoop() {
    window.clearInterval(this.locationTimer);
    if (!this.config) return;
    this.locationTimer = window.setInterval(async () => {
      try {
        await this.sendLocation(await getPosition());
      } catch (err) {
        void this.logEvent(isPermissionDenied(err) ? "location_denied" : "location_unavailable");
      }
    }, this.config.location_interval_minutes * 60_000);
  }

  // ---------- capture ----------

  private async grabFrame(): Promise<{ blob: Blob; width: number; height: number } | "blank"> {
    let source: CanvasImageSource | null = null;
    let w = 0;
    let h = 0;
    let bitmap: ImageBitmap | null = null;

    if (this.imageCapture) {
      try {
        bitmap = await this.imageCapture.grabFrame();
        source = bitmap;
        w = bitmap.width;
        h = bitmap.height;
      } catch {
        /* fall back to the video element */
      }
    }
    if (!source && this.video && this.video.videoWidth > 0) {
      source = this.video;
      w = this.video.videoWidth;
      h = this.video.videoHeight;
    }
    if (!source) throw new Error("No frame available");

    if (isBlankFrame(source)) {
      bitmap?.close();
      return "blank";
    }

    const scale = Math.min(1, MAX_WIDTH / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
    bitmap?.close();

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), "image/jpeg", JPEG_QUALITY),
    );
    return { blob, width: canvas.width, height: canvas.height };
  }

  private async captureAndUpload() {
    if (this.sessionId === null || this.paused) return;
    try {
      const frame = await this.grabFrame();
      if (frame === "blank") {
        // Locked or sleeping display: don't store a black image.
        if (!this.blankStreak) void this.logEvent("blank_screen");
        this.blankStreak = true;
        return;
      }
      this.blankStreak = false;
      const form = new FormData();
      form.append("session_id", String(this.sessionId));
      form.append("width", String(frame.width));
      form.append("height", String(frame.height));
      form.append("file", frame.blob, "screenshot.jpg");
      await api("/tracking/screenshots", { method: "POST", form });
      this.update({ lastScreenshotAt: new Date() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        void this.heartbeat(); // learns why the session ended and recovers if appropriate
        return;
      }
      void this.logEvent("capture_failed", err instanceof Error ? err.message : String(err));
    }
  }

  private async sendLocation(pos: GeolocationPosition) {
    if (this.sessionId === null) return;
    try {
      await api("/tracking/locations", {
        method: "POST",
        body: {
          session_id: this.sessionId,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        },
      });
      this.update({ lastLocationAt: new Date() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) void this.heartbeat();
    }
  }

  private async heartbeat() {
    if (this.sessionId === null) return;
    try {
      const res = await api<HeartbeatResponse>(`/tracking/sessions/${this.sessionId}/heartbeat`, { method: "POST" });
      const old = this.config;
      this.config = res.config;
      if (!res.session_active) {
        if (res.end_reason === "heartbeat_lost") {
          this.handleSessionLost(); // computer slept / went offline — continue automatically
        } else {
          this.teardown(END_REASONS[res.end_reason ?? ""] ?? "Session ended.");
        }
        return;
      }
      if (old && old.screenshot_interval_minutes !== res.config.screenshot_interval_minutes) this.scheduleScreenshot();
      if (old && old.location_interval_minutes !== res.config.location_interval_minutes) this.startLocationLoop();
      if (this.lockDetection && old && old.inactivity_alert_minutes !== res.config.inactivity_alert_minutes) {
        void this.startLockDetection(); // admin changed the inactivity threshold
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) this.teardown("Signed out.");
      // Otherwise: temporary network problem, keep going.
    }
  }

  private async logEvent(eventType: string, detail?: string) {
    try {
      await api("/tracking/events", {
        method: "POST",
        body: { session_id: this.sessionId, event_type: eventType, detail },
      });
    } catch {
      /* best effort */
    }
  }
}
