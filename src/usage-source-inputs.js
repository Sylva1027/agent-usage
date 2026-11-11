import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { automaticPricingFile, pricingFile } from "./pricing-store.js";
import { codexQuotaFile, readCodexQuotaObservations } from "./codex-quota-cache.js";
import { invalidateServiceTierLog } from "./service-tier-evidence.js";
import { invalidateQuotaSourceLog } from "./quota-source-evidence.js";

const logInputs = new Map();
async function logEvidenceInput(file) {
  let database;
  try {
    const info = await stat(file);
    database = new DatabaseSync(file, { readOnly: true });
    const hash = createHash("sha256");
    const rows = database.prepare(`SELECT id,ts,ts_nanos,thread_id,target,feedback_log_body FROM logs
      WHERE thread_id IS NOT NULL AND (
        (target='codex_core::session::handlers' AND feedback_log_body LIKE '%service_tier:%') OR
        (thread_id<>'' AND target='feedback_tags' AND feedback_log_body LIKE '%auth_mode%') OR
        (thread_id<>'' AND target='codex_http_client::client' AND feedback_log_body LIKE '%transport="responses_http"%'
          AND feedback_log_body LIKE '%api.path="/responses"%' AND feedback_log_body LIKE '%url=%')) ORDER BY id`);
    rows.setReturnArrays(true);
    for (const row of rows.iterate()) hash.update(JSON.stringify(row)).update("\n");
    const after = await stat(file);
    if (info.dev !== after.dev || info.ino !== after.ino) return null;
    const observation = JSON.stringify([file, "evidence-v1", info.dev, info.ino, hash.digest("hex")]);
    if (logInputs.get(file) !== observation) {
      invalidateServiceTierLog(file);
      invalidateQuotaSourceLog(file);
      logInputs.set(file, observation);
    }
    return observation;
  } catch {
    // Unreadable or unknown log schemas retain the original physical-file checks.
    return null;
  } finally {
    database?.close();
  }
}

/** Small, non-history inputs; shared by acquisition and response publication. */
export async function readUsageSourceInputs(options, homes, fingerprint) {
  const prices = new Set([pricingFile(options), automaticPricingFile(options)]);
  const files = new Set([...prices, options.importStoreFile, codexQuotaFile(options)].filter(Boolean));
  for (const home of homes) {
    for (const name of ["config.toml", "settings.json", "config.json", "logs_2.sqlite", "logs_2.sqlite-wal"])
      files.add(path.join(home.path, name));
  }
  const input = createHash("sha256").update("acquisition-input-v1\0").update(fingerprint);
  const auxiliary = createHash("sha256").update("acquisition-input-v1\0");
  const routing = createHash("sha256").update(fingerprint);
  const quota = JSON.stringify(readCodexQuotaObservations({ ...options, homes }));
  input.update("\0quota\0").update(quota);
  auxiliary.update("\0quota\0").update(quota);
  routing.update("\0quota\0").update(quota);
  const verifiedLogs = new Set();
  for (const file of [...files].sort()) {
    if (file.endsWith("logs_2.sqlite-wal") && verifiedLogs.has(file.slice(0, -4))) continue;
    let observation;
    if (file.endsWith("logs_2.sqlite")) {
      observation = await logEvidenceInput(file);
      if (observation !== null) verifiedLogs.add(file);
    }
    if (!observation) {
      try {
        const info = await stat(file);
        observation = JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        observation = JSON.stringify([file, "missing"]);
      }
    }
    input.update(observation);
    auxiliary.update(observation);
    if (!prices.has(file)) routing.update(observation);
  }
  return {
    inputs: input.digest("hex"),
    auxiliary: auxiliary.digest("hex"),
    routingFingerprint: routing.digest("hex"),
    files: [...files],
  };
}
