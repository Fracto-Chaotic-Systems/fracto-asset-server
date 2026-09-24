const FRACTO_DATA_PORT = Number(process.env.FRACTO_DATA_PORT || 3002);
import {
  cancel_video_frame_render,
  start_video_frame_render,
  enumerate_video_frames,
} from "./video_frame_renderer.js";
import { cancel_video_encoding, start_video_encoding } from "./video_encoder.js";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const data_origin = `http://${data_host}:${FRACTO_DATA_PORT}`;

const RENDER_STATES = new Set([
  "idle",
  "queued",
  "running",
  "encoding",
  "completed",
  "frames_ready",
  "failed",
  "cancelled",
]);

const get_id = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "A valid video id is required" });
    return null;
  }
  return id;
};

const request_video = async (id) => {
  const response = await fetch(`${data_origin}/video/${id}`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error || `Data server returned HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return result.result;
};

const format_datetime = (date = new Date()) =>
  date.toISOString().slice(0, 19).replace("T", " ");

const update_render = async (id, values) => {
  const response = await fetch(`${data_origin}/video/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error || `Data server returned HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
};

const send_error = (res, error) => {
  const status = Number.isInteger(error.status) ? error.status : 503;
  res.status(status).json({ error: error.message });
};

/** Return the current render lifecycle for a video. */
export const handle_render_status = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    res.status(200).json({
      id,
      render_state: video.render_state || "idle",
      render_progress: Number(video.render_progress) || 0,
      render_error: video.render_error || null,
      render_started_at: video.render_started_at || null,
      render_completed_at: video.render_completed_at || null,
      render_output_uri: video.render_output_uri || null,
      render_output_url:
        (video.render_state || "idle") === "completed"
          ? `/video/${id}/render/output`
          : null,
      render_frame_count: video.render_frame_count || null,
    });
  } catch (error) {
    send_error(res, error);
  }
};

/** Stream only the completed, server-generated output for a video. */
export const handle_render_output = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    if ((video.render_state || "idle") !== "completed") {
      res.status(409).json({
        error: "A completed video render is required",
        render_state: video.render_state || "idle",
      });
      return;
    }
    const output_root = path.resolve(
      process.env.FRACTO_VIDEO_OUTPUT_DIR || path.join(process.cwd(), "videos"),
    );
    const output_path = path.resolve(`${video.render_output_uri || ""}`);
    const root_prefix = `${output_root}${path.sep}`;
    if (!output_path.startsWith(root_prefix)) {
      res.status(404).json({ error: "Video output is not available" });
      return;
    }
    const file_stat = await fs.stat(output_path);
    if (!file_stat.isFile()) throw new Error("Video output is not a file");
    const extension = path.extname(output_path).toLowerCase();
    const content_types = {
      ".mkv": "video/x-matroska",
      ".mov": "video/quicktime",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    };
    res.setHeader("Content-Type", content_types[extension] || "application/octet-stream");
    const range = req.headers.range;
    let start = 0;
    let end = file_stat.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${file_stat.size}`);
        res.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) {
        end = Number(match[2]);
      } else if (!match[1]) {
        const suffix_length = Number(match[2]);
        start = Math.max(0, file_stat.size - suffix_length);
        end = file_stat.size - 1;
      }
      if (start > end || start >= file_stat.size) {
        res.status(416).setHeader("Content-Range", `bytes */${file_stat.size}`);
        res.end();
        return;
      }
      end = Math.min(end, file_stat.size - 1);
      res.status(206);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", `bytes ${start}-${end}/${file_stat.size}`);
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${path.basename(output_path)}"`,
    );
    createReadStream(output_path, { start, end }).pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(error.code === "ENOENT" ? 404 : 500).json({
        error: error.code === "ENOENT" ? "Video output is not available" : error.message,
      });
    } else {
      res.end();
    }
  }
};

/** Queue a video and begin producing its numbered PNG frames. */
export const handle_render_create = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    const current_state = video.render_state || "idle";
    if (
      current_state === "queued" ||
      current_state === "running" ||
      current_state === "encoding"
    ) {
      res.status(409).json({
        error: "Video render is already active",
        render_state: current_state,
      });
      return;
    }
    await update_render(id, {
      render_state: "queued",
      render_progress: 0,
      render_error: null,
      render_started_at: null,
      render_completed_at: null,
      render_output_uri: null,
    });
    start_video_frame_render(id, video).catch((error) =>
      console.error("video frame render failed", error.message),
    );
    res.status(202).json({ id, render_state: "queued", render_progress: 0 });
  } catch (error) {
    send_error(res, error);
  }
};

/** Cancel a queued or running render without deleting its video project. */
export const handle_render_cancel = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    const current_state = video.render_state || "idle";
    if (!RENDER_STATES.has(current_state)) {
      res.status(500).json({ error: "Video has an invalid render state" });
      return;
    }
    if (
      current_state !== "queued" &&
      current_state !== "running" &&
      current_state !== "encoding"
    ) {
      res.status(200).json({ id, render_state: current_state });
      return;
    }
    cancel_video_frame_render(id);
    cancel_video_encoding(id);
    await update_render(id, {
      render_state: "cancelled",
      render_completed_at: format_datetime(),
    });
    res.status(200).json({ id, render_state: "cancelled" });
  } catch (error) {
    send_error(res, error);
  }
};

/** Assemble frames that reached `frames_ready`, useful after a server restart. */
export const handle_render_assemble = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    if ((video.render_state || "idle") !== "frames_ready") {
      res.status(409).json({
        error: "Only renders with frames_ready state can be assembled",
        render_state: video.render_state || "idle",
      });
      return;
    }
    const render_root = path.resolve(
      process.env.FRACTO_VIDEO_RENDER_DIR ||
        path.join(process.cwd(), "video-renders"),
    );
    const workspace = path.resolve(`${video.render_output_uri || ""}`);
    const expected_workspace = path.join(render_root, `${id}`);
    if (workspace !== expected_workspace) {
      res.status(400).json({ error: "Video frame workspace is not valid" });
      return;
    }
    start_video_encoding(id, video, workspace, enumerate_video_frames(video)).catch(
      (error) => console.error("video assembly failed", error.message),
    );
    res.status(202).json({ id, render_state: "encoding", render_progress: 100 });
  } catch (error) {
    send_error(res, error);
  }
};

/** Re-queue a failed or cancelled render using the current video definition. */
export const handle_render_retry = async (req, res) => {
  const id = get_id(req, res);
  if (!id) return;
  try {
    const video = await request_video(id);
    const current_state = video.render_state || "idle";
    if (current_state !== "failed" && current_state !== "cancelled") {
      res.status(409).json({
        error: "Only failed or cancelled renders can be retried",
        render_state: current_state,
      });
      return;
    }
    await update_render(id, {
      render_state: "queued",
      render_progress: 0,
      render_error: null,
      render_started_at: null,
      render_completed_at: null,
      render_output_uri: null,
    });
    start_video_frame_render(id, video).catch((error) =>
      console.error("video frame render retry failed", error.message),
    );
    res.status(202).json({ id, render_state: "queued", render_progress: 0 });
  } catch (error) {
    send_error(res, error);
  }
};
