import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BEGIN = "# codex-usage local output capture begin";
const END = "# codex-usage local output capture end";

/** Add one supported Cordis plugin entry, preserving the user's existing patch. */
export async function installDshOutputCapture({ home, collector }) {
  home = path.resolve(home);
  collector = path.resolve(collector);
  const plugin = await import(pathToFileURL(collector).href);
  if (plugin.name !== "local-output-speed" || typeof plugin.apply !== "function") {
    throw new TypeError("The collector is not the local output capture plugin");
  }
  const file = path.join(home, "cordis.patch.yml");
  await mkdir(home, { recursive: true });
  const original = await readFile(file, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const block = `${BEGIN}\n- insert:\n    - id: codex-usage-local-output\n      name: ${JSON.stringify(pathToFileURL(collector).href)}\n      config:\n        home: ${JSON.stringify(home)}\n${END}`;
  const start = original.indexOf(BEGIN);
  const end = original.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error("Incomplete local output capture entry in Cordis patch");
  }
  const updated = start < 0
    ? `${original}${original && !original.endsWith("\n") ? "\n" : ""}${block}\n`
    : `${original.slice(0, start)}${block}${original.slice(end + END.length)}`;
  if (updated === original) return { changed: false, file, collector, backup: null };
  const backup = original === "" ? null : `${file}.before-local-output-${randomUUID()}.bak`;
  if (backup) await copyFile(file, backup);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { changed: true, file, collector, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {
    home: process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
    collector: fileURLToPath(new URL("./dsh-output-capture.mjs", import.meta.url)),
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    if (!args[index]?.startsWith("--") || !Object.hasOwn(options, key) || !args[index + 1]) {
      throw new Error("Usage: install-dsh-output-capture.mjs [--home <path>] [--collector <path>]");
    }
    options[key] = args[index + 1];
  }
  console.log(JSON.stringify(await installDshOutputCapture(options)));
}
