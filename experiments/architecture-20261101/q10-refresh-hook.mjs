import "./q9-hook.mjs";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./q9-benchmark.mjs";
import { transform } from "./q10-refresh-run.mjs";

const file = process.env.Q6_PERFORMANCE_CONFIG;
if (file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  globalThis.__q10Native = (request, response, started) => {
    if (request.op !== "changes" && response?.ok) return;
    appendFileSync(path.join(config.output, `q10-${process.pid}.ndjson`), JSON.stringify({ at: Date.now(), pid: process.pid,
      label: "native-directory", operation: request.op, duration: performance.timeOrigin + performance.now() - started,
      ok: response?.ok, reason: response?.reason, records: response?.value?.records?.length, journalBytes: response?.value?.journalBytes }) + "\n");
  };
  registerHooks({ load(url, context, next) {
    const result = next(url, context); if (!url.startsWith("file:")) return result;
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (relative === "src/usage-source-native.js") {
      const needle = "      const response = await this.#request(payload);";
      assert.equal(String(result.source).split(needle).length, 2);
      return { ...result, source: result.source.replace(needle, `const q10Started=performance.timeOrigin+performance.now();
        ${needle}globalThis.__q10Native(payload,response,q10Started);`) };
    }
    if (relative.endsWith("/q5-summary-hook.mjs")) {
      // Q9 already adapts append response capture in the runner; only add browser timing here.
      const source = String(result.source), original = "  window.__q5Delivery={rows,get dropped(){return dropped;}};";
      const transformed = transform(relative, source.replace("row.body=body;", ""));
      assert.ok(transformed.includes("json-consumed") && source.includes(original));
      return { ...result, source: transformed };
    }
    return result;
  } });
}
