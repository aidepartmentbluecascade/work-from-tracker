/**
 * Browser-side tracker.
 *
 * - Asks the user to share their ENTIRE screen once per session (getDisplayMedia).
 * - Grabs a frame from that stream every N minutes (admin setting, with random jitter)
 *   and uploads it to the backend, which stores it in Google Cloud Storage.
 * - Sends the browser's geolocation every M minutes.
 * - Sends a heartbeat every minute; the server ends the session when the user's
 *   work timeline ends, tracking is disabled, or heartbeats stop.
 */
import { api, ApiError } from "./api";
import { END_REASONS } from "./format";
import type { HeartbeatResponse, TrackingConfig, WorkSession } from "./types";

export interface TrackerStatus {
  active: boolean;
  sessionId: number | null;
  startedAt: Date | null;
  lastScreenshotAt: Date | null;
  lastLocationAt: Date | null;
  message: string | null;
}

const HEARTBEAT_MS = 60_000;
const MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.7;

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}

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
  return typeof GeolocationPositionError !== "undefined" && err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED;
}

export class Tracker {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private imageCapture: ImageCaptureLike | null = null;
  private config: TrackingConfig | null = null;
  private sessionId: number | null = null;
  private shotTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private locationTimer: number | undefined;
  private status: TrackerStatus = {
    active: false,
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
    return this.sessionId !== null;
  }

  async start(): Promise<void> {
    if (this.isActive) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("This browser can't capture the screen. Please use Chrome, Edge or Firefox on a computer.");
    }

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
      // Position unavailable / timeout: continue, but report it.
    }

    // 2) Screen-share permission. Must be the entire screen.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor", frameRate: 1 },
        audio: false,
        // Chrome/Edge hints: offer whole screens, hide this tab and switching.
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
      } as DisplayMediaStreamOptions);
    } catch {
      throw new Error("Screen sharing is required to start work. Please choose your entire screen.");
    }
    const track = stream.getVideoTracks()[0];
    const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    if (surface && surface !== "monitor") {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Please share your "Entire screen", not a window or tab.');
    }

    // 3) Open a session on the server.
    let session: WorkSession;
    try {
      session = await api<WorkSession>("/tracking/sessions/start", { method: "POST" });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }

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

    this.update({
      active: true,
      sessionId: session.id,
      startedAt: new Date(session.started_at),
      lastScreenshotAt: null,
      lastLocationAt: null,
      message: null,
    });

    if (position) void this.sendLocation(position);
    else void this.logEvent("location_unavailable", "Position unavailable at start");

    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.startLocationLoop();
    this.scheduleScreenshot(5_000); // first capture shortly after starting
  }

  async stop(reason = "manual"): Promise<void> {
    const id = this.sessionId;
    if (id === null) return;
    this.teardown(reason === "manual" ? "You stopped work." : END_REASONS[reason] ?? reason);
    await api(`/tracking/sessions/${id}/stop`, { method: "POST", body: { reason } }).catch(() => undefined);
  }

  // ---------- internals ----------

  private teardown(message: string | null) {
    window.clearTimeout(this.shotTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.locationTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.imageCapture = null;
    this.sessionId = null;
    this.update({ active: false, sessionId: null, message });
  }

  private onVisibility = () => {
    void this.logEvent(document.hidden ? "tab_hidden" : "tab_visible");
  };

  private scheduleScreenshot(delayMs?: number) {
    window.clearTimeout(this.shotTimer);
    if (!this.config) return;
    const base = this.config.screenshot_interval_minutes * 60_000;
    const jitter = this.config.screenshot_jitter_percent / 100;
    const delay = delayMs ?? Math.max(30_000, base * (1 + (Math.random() * 2 - 1) * jitter));
    this.shotTimer = window.setTimeout(async () => {
      await this.captureAndUpload();
      if (this.isActive) this.scheduleScreenshot();
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

  private async grabFrame(): Promise<{ blob: Blob; width: number; height: number }> {
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
    if (this.sessionId === null) return;
    try {
      const { blob, width, height } = await this.grabFrame();
      const form = new FormData();
      form.append("session_id", String(this.sessionId));
      form.append("width", String(width));
      form.append("height", String(height));
      form.append("file", blob, "screenshot.jpg");
      await api("/tracking/screenshots", { method: "POST", form });
      this.update({ lastScreenshotAt: new Date() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.teardown(END_REASONS.heartbeat_lost);
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
    } catch {
      /* next ping will retry */
    }
  }

  private async heartbeat() {
    if (this.sessionId === null) return;
    try {
      const res = await api<HeartbeatResponse>(`/tracking/sessions/${this.sessionId}/heartbeat`, { method: "POST" });
      const old = this.config;
      this.config = res.config;
      if (!res.session_active) {
        this.teardown(END_REASONS[res.end_reason ?? ""] ?? "Session ended.");
        return;
      }
      // Admin changed intervals: apply them without restarting.
      if (old && old.screenshot_interval_minutes !== res.config.screenshot_interval_minutes) this.scheduleScreenshot();
      if (old && old.location_interval_minutes !== res.config.location_interval_minutes) this.startLocationLoop();
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
