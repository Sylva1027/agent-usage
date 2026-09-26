import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mergePricingCatalog, resetPricingCatalog, setPricingCatalog } from "./pricing.js";

export function pricingFile(options = {}) {
  return options.pricingFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "pricing.json");
}

export async function loadPricingFile(options = {}) {
  let saved;
  try {
    saved = JSON.parse(await readFile(pricingFile(options), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      resetPricingCatalog();
      return;
    }
    throw error;
  }
  try {
    setPricingCatalog(saved);
  } catch {
    // 旧版价目缺少新增的内置模型（如人民币模型）时按内置补齐；仍无法校验则回退内置价目。
    try {
      setPricingCatalog(mergePricingCatalog(saved));
    } catch {
      resetPricingCatalog();
    }
  }
}

export async function savePricingFile(options, catalog) {
  const file = pricingFile(options);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

