import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { automaticPricingFile, pricingFile } from "./pricing-store.js";
import { codexQuotaFile, readCodexQuotaObservations } from "./codex-quota-cache.js";

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
  for (const file of [...files].sort()) {
    let observation;
    try {
      const info = await stat(file);
      observation = JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      observation = JSON.stringify([file, "missing"]);
    }
    input.update(observation);
    auxiliary.update(observation);
    if (!prices.has(file)) routing.update(observation);
  }
  return { inputs: input.digest("hex"), auxiliary: auxiliary.digest("hex"),
    routingFingerprint: routing.digest("hex"), files: [...files] };
}
