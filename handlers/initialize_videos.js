import chalk from "chalk";

import { FRACTO_DATA_PORT } from "../../../constants.js";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";

/**
 * Semantic definition of the asset server's video-project table. The data
 * server receives this definition and remains the only process that connects
 * to MySQL or executes the DDL.
 */
export const VIDEO_TABLE_DEFINITION = {
  table: "videos",
  columns: [
    { name: "id", type: "BIGINT UNSIGNED", nullable: false, auto_increment: true, primary_key: true },
    { name: "title", type: "VARCHAR(255)", nullable: false },
    { name: "created_at", type: "TIMESTAMP", nullable: false, default_current_timestamp: true },
    { name: "updated_at", type: "TIMESTAMP", nullable: false, default_current_timestamp: true, on_update_current_timestamp: true },
    { name: "meta", type: "JSON", nullable: false },
    { name: "script", type: "JSON", nullable: false },
    { name: "meta_version", type: "INT UNSIGNED", nullable: false, default_value: 1 },
    { name: "script_version", type: "INT UNSIGNED", nullable: false, default_value: 1 },
  ],
};

/** Ensure that the asset server's video table exists before serving requests. */
export const initialize_videos_table = async () => {
  const response = await fetch(
    `http://${data_host}:${FRACTO_DATA_PORT}/ensure_table`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VIDEO_TABLE_DEFINITION),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Data server returned HTTP ${response.status}`);
  }
  console.log(chalk.green(`videos table is ready (${result.table})`));
  return result;
};
