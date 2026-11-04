import assert from "node:assert/strict";
import test from "node:test";
import { classifyClosedUsageStreams } from "../scripts/skin-palette/capture.mjs";

test("capture accepts only an explicitly closed SSE request and retains unrelated transport failures", () => {
  const url = "http://127.0.0.1:9876/api/usage-events";
  const closed = { url, resourceType: "eventsource", error: "net::ERR_ABORTED" };
  const others = [
    { ...closed, error: "net::ERR_CONNECTION_RESET" },
    { ...closed, resourceType: "fetch" },
    { ...closed, url: "http://127.0.0.1:9876/api/usage" },
    { ...closed },
  ];
  assert.deepEqual(classifyClosedUsageStreams([closed, ...others], [url]), { closed: [closed], unexpected: others });
  assert.deepEqual(classifyClosedUsageStreams([closed], []), { closed: [], unexpected: [closed] });
});
