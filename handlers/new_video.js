import { FRACTO_DATA_PORT } from "../../../constants.js";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const data_origin = `http://${data_host}:${FRACTO_DATA_PORT}`;

/**
 * Create a new video project with the initial metadata and script shape.
 * The asset server owns these defaults and delegates persistence to the data
 * server, which returns the generated database id.
 *
 * @param {import("express").Request} req New-video request (no body required).
 * @param {import("express").Response} res Created video record details.
 */
export const handle_new_video = async (req, res) => {
  const title = `vid_${Math.round(Math.random() * 100000000)}`;
  const video = {
    title,
    meta: {
      description: "",
      frame_size: 1024,
      frame_rate: 30,
      format: null,
      codec: null,
      pixel_format: null,
      bitrate: null,
      quality: null,
      aspect_ratio: 1,
      duration: null,
      audio: {
        enabled: false,
        codec: null,
        sample_rate: null,
        channels: null,
        frequency: null,
      },
      color_space: {
        primaries: null,
        transfer: null,
        matrix: null,
        range: null,
      },
      keyframe_interval: null,
      output_extension: null,
      output_uri: null,
      thumbnail: { enabled: false, frame_index: null, output_uri: null },
      render_engine: null,
      capability_version: null,
      created_by: null,
      updated_by: null,
    },
    script: { steps: [] },
    meta_version: 1,
    script_version: 1,
  };
  try {
    const response = await fetch(`${data_origin}/video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(video),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(response.status).json(result);
      return;
    }
    res.status(201).json({ ...video, id: result.id });
  } catch (error) {
    console.error("error creating video", error.message);
    res.status(503).json({ error: error.message });
  }
};
