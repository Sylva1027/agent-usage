import path from "node:path";

import { installHttpCapture } from "../src/perf-http-capture.js";
import {
  appendOutputObservation,
  workbuddyOutputObservationFile,
} from "../src/perf-output-observations.js";

// Loaded with Node --import by the dedicated launcher; normal installations are untouched.
const home = process.env.CODEX_USAGE_CAPTURE_HOME;
if (home && path.isAbsolute(home)) {
  let writes = Promise.resolve();
  installHttpCapture({
    onMeasurement: ({ sessionId, messageId }, result) => {
      if (!sessionId || !messageId || !result?.model || !result.measurement) return;
      const outputFile = workbuddyOutputObservationFile(home, sessionId);
      writes = writes.catch(() => {}).then(() => appendOutputObservation(outputFile, {
        schemaVersion: 2,
        sourceKind: "workbuddy",
        sessionId,
        messageId,
        model: result.model,
        clock: "transport_receive",
        measurement: result.measurement,
      }));
      return writes;
    },
  });
}
