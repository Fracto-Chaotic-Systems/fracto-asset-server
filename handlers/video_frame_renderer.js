import fs from "fs/promises";
import path from "path";
import { createCanvas } from "canvas";

const FRACTO_DATA_PORT = Number(process.env.FRACTO_DATA_PORT || 3002);
const FRACTO_TILES_PORT = Number(process.env.FRACTO_TILES_PORT || 3004);
import FractoColors from "@fracto/sdk/FractoColors.js";
import { start_video_encoding } from "./video_encoder.js";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const tiles_host = process.env.FRACTO_TILES_HOST || "127.0.0.1";
const render_root = path.resolve(
  process.env.FRACTO_VIDEO_RENDER_DIR ||
    path.join(process.cwd(), "video-renders"),
);
const requested_concurrency = Number(
  process.env.FRACTO_VIDEO_RENDER_CONCURRENCY || 1,
);
const RENDER_CONCURRENCY = Math.max(
  1,
  Math.min(
    8,
    Number.isFinite(requested_concurrency) ? requested_concurrency : 1,
  ),
);
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_SECONDS_PER_STEP = 1;
const requested_timeout_ms = Number(
  process.env.FRACTO_VIDEO_RENDER_REQUEST_TIMEOUT_MS || 120000,
);
const RENDER_REQUEST_TIMEOUT_MS =
  Number.isFinite(requested_timeout_ms) && requested_timeout_ms > 0
    ? requested_timeout_ms
    : 120000;
const requested_retries = Number(
  process.env.FRACTO_VIDEO_FRAME_RETRIES || 4,
);
const FRAME_REQUEST_RETRIES = Math.max(
  1,
  Math.min(8, Number.isFinite(requested_retries) ? requested_retries : 4),
);

const active_jobs = new Map();

const parse_json = (value, fallback) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const video_meta = (video) => parse_json(video?.meta, {});

const video_steps = (video) => {
  const script = parse_json(video?.script, {});
  return Array.isArray(script?.steps)
    ? script.steps.filter(
        (step) =>
          Number.isFinite(step?.focal_point?.x) &&
          Number.isFinite(step?.focal_point?.y) &&
          Number.isFinite(step?.scope) &&
          step.scope > 0,
      )
    : [];
};

/**
 * Enumerate deterministic frame settings for a video script.
 * An explicit meta.duration wins; otherwise each script segment occupies one
 * second, providing a useful default until the render UI exposes durations.
 */
export const enumerate_video_frames = (video) => {
  const meta = video_meta(video);
  const steps = video_steps(video);
  if (!steps.length) {
    throw new Error("Video script contains no renderable steps");
  }
  const frame_rate =
    Number(meta.frame_rate) > 0 ? Number(meta.frame_rate) : DEFAULT_FRAME_RATE;
  const inferred_duration = Math.max(
    1,
    (steps.length - 1) * DEFAULT_SECONDS_PER_STEP,
  );
  const duration =
    Number(meta.duration) > 0 ? Number(meta.duration) : inferred_duration;
  const frame_count = Math.max(2, Math.ceil(duration * frame_rate));
  const frames = [];
  for (let frame_index = 0; frame_index < frame_count; frame_index += 1) {
    const t = frame_count === 1 ? 0 : frame_index / (frame_count - 1);
    const position = t * (steps.length - 1);
    const step_index = Math.min(steps.length - 2, Math.floor(position));
    const local_t = steps.length === 1 ? 0 : position - step_index;
    const current = steps[step_index] || steps[0];
    const next = steps[step_index + 1] || current;
    frames.push({
      frame_index,
      t,
      focal_point: {
        x:
          current.focal_point.x +
          (next.focal_point.x - current.focal_point.x) * local_t,
        y:
          current.focal_point.y +
          (next.focal_point.y - current.focal_point.y) * local_t,
      },
      scope: current.scope + (next.scope - current.scope) * local_t,
    });
  }
  return {
    frames,
    frame_rate,
    width_px: Math.max(1, Math.round(Number(meta.frame_size) || 1024)),
    aspect_ratio: Number(meta.aspect_ratio) > 0 ? Number(meta.aspect_ratio) : 1,
  };
};

const format_datetime = (date = new Date()) =>
  date.toISOString().slice(0, 19).replace("T", " ");

const update_video_render = async (id, values) => {
  const response = await fetch(
    `http://${data_host}:${FRACTO_DATA_PORT}/video/${id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
      signal: AbortSignal.timeout(RENDER_REQUEST_TIMEOUT_MS),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      result.error || `Data server returned HTTP ${response.status}`,
    );
  }
  return result;
};

const persist_render_progress = async (id, progress) => {
  try {
    await update_video_render(id, { render_progress: progress });
  } catch (error) {
    // Progress is advisory. A transient data-server timeout must not discard
    // a successfully rendered frame; the terminal state is persisted later.
    console.warn("video render progress update failed", error.message);
  }
};

const is_retryable_canvas_error = (error) => {
  const code = error?.code || error?.cause?.code;
  return (
    [
      "ETIMEDOUT",
      "ETIMEOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code) ||
    error?.name === "TimeoutError" ||
    error?.status === 408 ||
    error?.status === 429 ||
    error?.status >= 500
  );
};

const wait_for_retry = (attempt) =>
  new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)));

const request_canvas_buffer = async ({
  width_px,
  aspect_ratio,
  focal_point,
  scope,
  context,
  frame_index,
}) => {
  const params = new URLSearchParams({
    width_px: `${width_px}`,
    focal_point_x: `${focal_point.x}`,
    focal_point_y: `${focal_point.y}`,
    scope: `${scope}`,
    aspect_ratio: `${aspect_ratio}`,
    resolution_factor: "1.5",
  });
  const url = `http://${tiles_host}:${FRACTO_TILES_PORT}/canvas_buffer?${params}`;
  let last_error;
  for (let attempt = 0; attempt < FRAME_REQUEST_RETRIES; attempt += 1) {
    if (context?.cancel_requested) throw new Error("Render cancelled");
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(RENDER_REQUEST_TIMEOUT_MS),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.canvas_buffer)) {
        const error = new Error(
          result.error || `Tiles server returned HTTP ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }
      return result.canvas_buffer;
    } catch (error) {
      last_error = error;
      if (!is_retryable_canvas_error(error) || attempt === FRAME_REQUEST_RETRIES - 1) {
        throw error;
      }
      console.warn(
        "video frame request retry",
        frame_index,
        attempt + 1,
        error.message,
      );
      await wait_for_retry(attempt);
    }
  }
  throw last_error;
};

const write_frame_png = async (
  workspace,
  frame,
  render_settings,
  job_context,
) => {
  const height_px = Math.max(
    1,
    Math.round(render_settings.width_px * render_settings.aspect_ratio),
  );
  const canvas = createCanvas(render_settings.width_px, height_px);
  const context = canvas.getContext("2d");
  let canvas_buffer;
  try {
    canvas_buffer = await request_canvas_buffer({
      width_px: render_settings.width_px,
      aspect_ratio: render_settings.aspect_ratio,
      focal_point: frame.focal_point,
      scope: frame.scope,
      context: job_context,
      frame_index: frame.frame_index,
    });
  } catch (error) {
    throw new Error(`Frame ${frame.frame_index} failed: ${error.message}`, {
      cause: error,
    });
  }
  FractoColors.buffer_to_canvas(canvas_buffer, context);
  const filename = `frame_${`${frame.frame_index}`.padStart(8, "0")}.png`;
  await fs.writeFile(
    path.join(workspace, filename),
    canvas.toBuffer("image/png"),
  );
};

const run_frame_workers = async (
  workspace,
  frames,
  render_settings,
  context,
) => {
  let next_frame_index = 0;
  const worker = async () => {
    while (true) {
      if (context.cancel_requested) throw new Error("Render cancelled");
      const frame_index = next_frame_index;
      next_frame_index += 1;
      if (frame_index >= frames.length) return;
      await write_frame_png(
        workspace,
        frames[frame_index],
        render_settings,
        context,
      );
      context.completed_frames += 1;
      if (
        context.completed_frames === 1 ||
        context.completed_frames === frames.length ||
        context.completed_frames %
          Math.max(1, Math.floor(frames.length / 100)) ===
          0
      ) {
        await persist_render_progress(
          context.video_id,
          Math.floor((context.completed_frames / frames.length) * 100),
        );
      }
    }
  };
  const worker_count = Math.min(RENDER_CONCURRENCY, frames.length);
  const results = await Promise.allSettled(
    Array.from({ length: worker_count }, worker),
  );
  const failed_worker = results.find((result) => result.status === "rejected");
  if (failed_worker) {
    throw failed_worker.reason;
  }
};

/** Request cancellation of an in-process frame render. */
export const cancel_video_frame_render = (video_id) => {
  const context = active_jobs.get(Number(video_id));
  if (context) context.cancel_requested = true;
};

/** Produce all numbered PNG frames for a video, leaving them for Stage 3. */
export const start_video_frame_render = (video_id, video) => {
  const id = Number(video_id);
  if (active_jobs.has(id)) return active_jobs.get(id).promise;
  const context = {
    video_id: id,
    cancel_requested: false,
    completed_frames: 0,
    promise: null,
  };
  context.promise = (async () => {
    const workspace = path.join(render_root, `${id}`);
    try {
      const render_settings = enumerate_video_frames(video);
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(workspace, { recursive: true });
      await update_video_render(id, {
        render_state: "running",
        render_progress: 0,
        render_error: null,
        render_started_at: format_datetime(),
        render_completed_at: null,
        render_frame_count: render_settings.frames.length,
        render_output_uri: workspace,
      });
      await run_frame_workers(
        workspace,
        render_settings.frames,
        render_settings,
        context,
      );
      await update_video_render(id, {
        render_state: "frames_ready",
        render_progress: 100,
        render_completed_at: null,
        render_output_uri: workspace,
      });
      await start_video_encoding(id, video, workspace, render_settings);
    } catch (error) {
      const cancelled =
        context.cancel_requested || error.message === "Render cancelled";
      await update_video_render(id, {
        render_state: cancelled ? "cancelled" : "failed",
        render_error: cancelled ? null : error.message,
        render_completed_at: format_datetime(),
      }).catch((update_error) =>
        console.error("video render state update failed", update_error.message),
      );
      if (cancelled) {
        await fs
          .rm(workspace, { recursive: true, force: true })
          .catch(() => {});
      }
    } finally {
      active_jobs.delete(id);
    }
  })();
  active_jobs.set(id, context);
  return context.promise;
};
