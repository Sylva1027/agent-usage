import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = path.resolve(import.meta.dirname, "../..");
const sourcePrefix = path.join(repository, "src") + path.sep;
const target = process.env.NODE_INDEX_TEST_ROOT || path.join(repository, ".codex-usage/node-index-20261030/candidate");
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const file = fileURLToPath(resolved.url);
  if (!file.startsWith(sourcePrefix)) return resolved;
  return { ...resolved, url: pathToFileURL(path.join(target, "src", path.relative(sourcePrefix, file))).href };
} });
