import { Worker } from "node:worker_threads";
import { transfer_error } from "../../../utils/instrument_transfer.js";

// Existing full PCM/index validators run off the HTTP event loop, one file at a
// time. The worker never publishes files or accesses upstream/network resources.
export async function validate_instrument_directory(
  directory,
  { signal } = {},
) {
  signal?.throwIfAborted();
  const worker = new Worker(
    new URL("./transfer_validation_worker.js", import.meta.url),
    {
      workerData: { directory },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      execArgv: [],
    },
  );
  let timeout, abort;
  try {
    await new Promise((resolve, reject) => {
      let replied = false;
      abort = () => {
        void worker.terminate();
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        void worker.terminate();
        reject(transfer_error("timeout", 503));
      }, 1800000);
      timeout.unref?.();
      worker.once("message", (value) => {
        replied = true;
        value.valid
          ? resolve()
          : reject(transfer_error("validation_failed", 422));
      });
      worker.once("error", () =>
        reject(transfer_error("validation_failed", 422)),
      );
      worker.once("exit", (code) => {
        if (code !== 0 || !replied)
          reject(transfer_error("validation_failed", 422));
      });
      if (signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
