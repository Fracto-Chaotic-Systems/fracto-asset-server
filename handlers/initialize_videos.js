import chalk from "chalk";

import { FRACTO_DATA_PORT } from "../../../constants.js";

const data_host = process.env.FRACTO_DATA_HOST || "127.0.0.1";
const requested_timeout_ms = Number(
  process.env.FRACTO_DATA_REQUEST_TIMEOUT_MS || 10000,
);
const DATA_REQUEST_TIMEOUT_MS =
  Number.isFinite(requested_timeout_ms) && requested_timeout_ms > 0
    ? requested_timeout_ms
    : 10000;

/**
 * Semantic definition of the asset server's video-project table. The data
 * server receives this definition and remains the only process that connects
 * to MySQL or executes the DDL.
 */
export const ASSETS_TABLE_DEFINITION = {
  table: "assets",
  columns: [
    { name: "id", type: "INT", nullable: false, auto_increment: true, primary_key: true },
    { name: "asset_id", type: "VARCHAR(45)", nullable: false, unique: true },
    { name: "width", type: "INT", nullable: false },
    { name: "height", type: "INT", nullable: false },
    { name: "focal_point_x", type: "DOUBLE", nullable: false },
    { name: "focal_point_y", type: "DOUBLE", nullable: false },
    { name: "scope", type: "DOUBLE", nullable: false },
    { name: "filename", type: "VARCHAR(45)", nullable: false },
    { name: "public_url", type: "VARCHAR(255)", nullable: false },
    { name: "asset_type", type: "VARCHAR(45)", nullable: false },
  ],
};

export const VIDEO_TABLE_DEFINITION = {
  table: "videos",
  columns: [
    { name: "id", type: "BIGINT UNSIGNED", nullable: false, auto_increment: true, primary_key: true },
    { name: "title", type: "VARCHAR(255)", nullable: false },
    { name: "created_at", type: "TIMESTAMP", nullable: false, default_current_timestamp: true },
    { name: "updated_at", type: "TIMESTAMP", nullable: false, default_current_timestamp: true, on_update_current_timestamp: true },
    { name: "archived", type: "TINYINT(1)", nullable: false, default_value: 0 },
    { name: "meta", type: "JSON", nullable: false },
    { name: "script", type: "JSON", nullable: false },
    { name: "meta_version", type: "INT UNSIGNED", nullable: false, default_value: 1 },
    { name: "script_version", type: "INT UNSIGNED", nullable: false, default_value: 1 },
  ],
};

/**
 * Ensure an asset-owned table through the data server.
 * @param {object} table_definition Semantic table and column definition.
 * @returns {Promise<object>} Initialization and migration result.
 */
export const initialize_asset_table = async (table_definition) => {
  console.log(chalk.cyan(`checking ${table_definition.table} table schema`));
  const response = await fetch(
    `http://${data_host}:${FRACTO_DATA_PORT}/ensure_table`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(table_definition),
      signal: AbortSignal.timeout(DATA_REQUEST_TIMEOUT_MS),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Data server returned HTTP ${response.status}`);
  }
  if (result.migrations?.length) {
    console.log(
      chalk.yellow(
        `${result.table} schema migration applied; added columns: ${result.migrations.join(", ")}`,
      ),
    );
  } else {
    console.log(chalk.green(`${result.table} table is ready`));
  }
  return result;
};

/** Ensure the asset server's required tables exist before serving requests. */
export const initialize_asset_tables = async () => {
  await initialize_asset_table(ASSETS_TABLE_DEFINITION);
  return initialize_asset_table(VIDEO_TABLE_DEFINITION);
};
