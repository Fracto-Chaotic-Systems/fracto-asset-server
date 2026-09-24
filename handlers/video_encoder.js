import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const FRACTO_DATA_PORT = Number(process.env.FRACTO_DATA_PORT || 3002);

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const ffmpeg_binary = process.env.FRACTO_FFMPEG_BIN || "ffmpeg";
const output_root = path.resolve(
  process.env.FRACTO_VIDEO_OUTPUT_DIR || path.join(process.cwd(), "videos"),
);
const requested_timeout_ms = Number(
  process.env.FRACTO_VIDEO_RENDER_TIMEOUT_MS || 3_600_000,
);
const render_timeout_ms =
  Number.isFinite(requested_timeout_ms) && requested_timeout_ms > 0
    ? Math.max(60_000, requested_timeout_ms)
    : 3_600_000;

const active_encodes = new Map();

const parse_json = (value, fallback) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const format_datetime = (date = new Date()) =>
  date.toISOString().slice(0, 19).replace("T", " ");

const update_video_render = async (id, values) => {
  const response = await fetch(`http://${data_host}:${FRACTO_DATA_PORT}/video/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
    signal: AbortSignal.timeout(render_timeout_ms),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Data server returned HTTP ${response.status}`);
  }
  return result;
};

const format_extension = (meta) => {
  const requested = `${meta.output_extension || meta.format || "mp4"}`
    .toLowerCase()
    .replace(/^\./, "");
  return new Set(["mp4", "webm", "mov", "mkv"]).has(requested)
    ? requested
    : "mp4";
};

const encoder_for = (extension, meta) => {
  const requested = `${meta.codec || ""}`.toLowerCase();
  if (extension === "webm") return requested === "av1" ? "libaom-av1" : "libvpx-vp9";
  if (requested === "hevc") return "libx265";
  return "libx264";
};

const pixel_format_for = (meta) => {
  const requested = `${meta.pixel_format || "yuv420p"}`;
  return new Set(["yuv420p", "yuv444p", "rgba"]).has(requested)
    ? requested
    : "yuv420p";
};

const number_arg = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const build_args = (workspace, output_path, video, render_settings) => {
  const meta = parse_json(video?.meta, {});
  const frame_rate = number_arg(render_settings?.frame_rate || meta.frame_rate, 30);
  const extension = format_extension(meta);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    `${frame_rate}`,
    "-i",
    path.join(workspace, "frame_%08d.png"),
    "-c:v",
    encoder_for(extension, meta),
    "-pix_fmt",
    pixel_format_for(meta),
  ];
  if (Number(meta.bitrate) > 0) args.push("-b:v", `${Math.round(meta.bitrate)}`);
  if (Number(meta.quality) >= 0) args.push("-crf", `${Number(meta.quality)}`);
  if (Number(meta.keyframe_interval) > 0) {
    args.push("-g", `${Math.round(meta.keyframe_interval)}`);
  }
  args.push(output_path);
  return { args, extension, frame_rate };
};

const run_ffmpeg = (args, context) =>
  new Promise((resolve, reject) => {
    if (context.cancel_requested) {
      reject(new Error("Render cancelled"));
      return;
    }
    const child = spawn(ffmpeg_binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    context.child = child;
    let diagnostics = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Video encoding timed out"));
    }, render_timeout_ms);
    child.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("ffmpeg is not installed or FRACTO_FFMPEG_BIN is invalid") : error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (context.cancel_requested || signal === "SIGTERM") {
        reject(new Error("Render cancelled"));
      } else if (code !== 0) {
        reject(new Error(diagnostics.trim() || `ffmpeg exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });

/** Cancel an active ffmpeg process for a video. */
export const cancel_video_encoding = (video_id) => {
  const context = active_encodes.get(Number(video_id));
  if (context) {
    context.cancel_requested = true;
    context.child?.kill("SIGTERM");
  }
};

/** Assemble numbered PNG frames into a video and persist the final output. */
export const start_video_encoding = (video_id, video, workspace, render_settings) => {
  const id = Number(video_id);
  if (active_encodes.has(id)) return active_encodes.get(id).promise;
  const context = { video_id: id, cancel_requested: false, child: null, promise: null };
  context.promise = (async () => {
    let output_path;
    try {
      await fs.mkdir(output_root, { recursive: true });
      const meta = parse_json(video?.meta, {});
      const extension = format_extension(meta);
      output_path = path.join(output_root, `video_${id}_${Date.now()}.${extension}`);
      const { args } = build_args(workspace, output_path, video, render_settings);
      await update_video_render(id, {
        render_state: "encoding",
        render_progress: 100,
        render_error: null,
        render_output_uri: output_path,
        render_completed_at: null,
      });
      await run_ffmpeg(args, context);
      await fs.access(output_path);
      await update_video_render(id, {
        render_state: "completed",
        render_progress: 100,
        render_error: null,
        render_output_uri: output_path,
        render_completed_at: format_datetime(),
      });
      await fs.rm(workspace, { recursive: true, force: true });
    } catch (error) {
      const cancelled = context.cancel_requested || error.message === "Render cancelled";
      await update_video_render(id, {
        render_state: cancelled ? "cancelled" : "failed",
        render_error: cancelled ? null : error.message,
        render_completed_at: format_datetime(),
      }).catch((update_error) =>
        console.error("video encoding state update failed", update_error.message),
      );
      if (cancelled && output_path) await fs.rm(output_path, { force: true }).catch(() => {});
    } finally {
      active_encodes.delete(id);
    }
  })();
  active_encodes.set(id, context);
  return context.promise;
};
