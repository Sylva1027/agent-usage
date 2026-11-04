import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Isolated validation only: keep the installed, potentially running helper untouched.
const helper = process.env.Q6_TEST_HELPER;
if (!helper || !existsSync(helper)) throw new Error("Q6_TEST_HELPER must name the private built helper");
const trace = process.env.Q6_TEST_TRACE;
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (file.endsWith(`${path.sep}src${path.sep}usage-source-native.js`)) {
    const source = readFileSync(file, "utf8").replace(
      "this.#executablePath = executablePath(internalExecutablePath);",
      `this.#executablePath = executablePath(internalExecutablePath || ${JSON.stringify(path.resolve(helper))});`);
    return { format: "module", source, shortCircuit: true };
  }
  if (trace && (file.endsWith(`${path.sep}src${path.sep}usage-store.js`) || file.endsWith(`${path.sep}src${path.sep}usage-core.js`))) {
    const label = file.endsWith("usage-store.js") ? "enumeration" : "discovery";
    const target = label === "enumeration" ? "async usageFiles(homes) {" : "export async function discoverUsageSources(options = {}) {";
    let source = readFileSync(file, "utf8");
    if (!source.includes(target)) throw new Error("Q6 guard target missing");
    source = `import { appendFileSync as q6Append, existsSync as q6Exists } from 'node:fs';\n` +
      source.replace(target, `${target}\nq6Append(${JSON.stringify(path.join(trace, "calls.ndjson"))}, JSON.stringify({pid:process.pid,kind:${JSON.stringify(label)}})+'\\n');
      if(q6Exists(${JSON.stringify(path.join(trace, "forbid"))})) throw new Error('Q6 forbidden full ${label}');`);
    if (label === "enumeration") source = source.replaceAll("this.lastAcquisitionWork = acquisition.work;",
      `this.lastAcquisitionWork = acquisition.work; q6Append(${JSON.stringify(path.join(trace, "acquisition.ndjson"))}, JSON.stringify({pid:process.pid,work:acquisition.work})+'\\n');`);
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
if (trace) appendFileSync(path.join(trace, "processes.ndjson"), JSON.stringify({ pid: process.pid, role: "hook", startedAt: new Date().toISOString() }) + "\n");
