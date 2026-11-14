import { parentPort, workerData } from "node:worker_threads";
import { verify_library } from "./library.js";

try {
  verify_library(workerData.directory);
  parentPort.postMessage({ valid: true });
} catch {
  parentPort.postMessage({ valid: false });
}
