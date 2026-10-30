import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";

import { normalizeMeasuredOutput } from "./perf-output-tokens.js";

export const workbuddyOutputObservationFile = (home, sessionId) =>
  path.join(home, "generation-timing", `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`);

export const outputObservationFile = (sourceFile, sourceKind) =>
  sourceKind === "workbuddy"
    ? workbuddyOutputObservationFile(
        path.dirname(path.dirname(path.dirname(sourceFile))),
        path.basename(sourceFile, ".jsonl"),
      )
    : `${sourceFile}.generation-timing.jsonl`;

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Keep only request identity and scalar measurements in the local companion file. */
export function normalizeOutputObservation(raw) {
  if (!raw || !["dsh", "workbuddy"].includes(raw.sourceKind)) return null;
  const schemaVersion = raw.sourceKind === "dsh" ? 2 : 1;
  if (raw.schemaVersion !== schemaVersion) return null;
  const messageId = text(raw.messageId);
  const sessionId = text(raw.sessionId) ?? "";
  const model = text(raw.model);
  const measurement = normalizeMeasuredOutput(raw.measurement);
  if (!messageId || !sessionId || !model || !measurement || raw.clock !== "transport_receive") return null;
  return {
    schemaVersion,
    sourceKind: raw.sourceKind,
    sessionId,
    messageId,
    model,
    modelProvider: text(raw.modelProvider) ?? "",
    clock: "transport_receive",
    measurement,
  };
}

export async function appendOutputObservation(file, raw) {
  const record = normalizeOutputObservation(raw);
  if (!record) throw new TypeError("Invalid output measurement");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** A disagreement for the same exact message identity remains a disagreement. */
export async function readOutputObservations(sourceFile, sourceKind) {
  const records = new Map();
  const fingerprints = new Map();
  try {
    const lines = createInterface({
      input: createReadStream(outputObservationFile(sourceFile, sourceKind)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const value = normalizeOutputObservation(raw);
      if (!value || value.sourceKind !== sourceKind) continue;
      const key = JSON.stringify([value.sessionId, value.messageId]);
      const signature = JSON.stringify(value);
      if (fingerprints.has(key) && fingerprints.get(key) !== signature) records.set(key, null);
      else if (!fingerprints.has(key)) {
        fingerprints.set(key, signature);
        records.set(key, value);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return (sessionId, messageId, model, modelProvider = "") => {
    const value = records.get(JSON.stringify([sessionId, messageId]));
    // WorkBuddy's request headers carry its local session/message IDs; wire model names may be aliases.
    return value && (sourceKind === "workbuddy" || (value.model === model && value.modelProvider === modelProvider))
      ? value.measurement
      : null;
  };
}
