import { FRACTO_DATA_PORT } from "../../../constants.js";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const data_origin = `http://${data_host}:${FRACTO_DATA_PORT}`;

/**
 * Update a video project through the data server.
 *
 * @param {import("express").Request} req Request with numeric `id` route
 * parameter and the complete video object in the JSON body.
 * @param {import("express").Response} res Data-server update result.
 */
export const handle_update_video = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "A valid video id is required" });
    return;
  }
  const body = req.body || {};
  try {
    const response = await fetch(`${data_origin}/video/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    res.status(response.status).json(result);
  } catch (error) {
    console.error("error updating video", error.message);
    res.status(503).json({ error: error.message });
  }
};
