import {process_logfile} from "@fracto/sdk/utils/Logging.js"

export const handle_logs = (req, res) => {
   process_logfile('fracto-asset-server', res)
}
