import { watch } from "node:fs";
import path from "node:path";

function normalizeRoots(roots) {
  const unique = new Map();
  for (const root of roots || []) {
    if (!root?.path) continue;
    const normalized = {
      path: path.resolve(root.path),
      recursive: root.recursive === true,
      filename: root.filename ? path.basename(root.filename) : null,
    };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()];
}

/**
 * File notifications are only hints. Source verification remains in UsageStore.
 * @param {{
 *   discoverRoots: () => Promise<Array<{ path: string, recursive?: boolean, filename?: string }>>,
 *   onHint?: () => unknown,
 *   ignorePath?: (filename: string) => boolean,
 *   debounceMs?: number,
 *   watchFile?: typeof watch,
 *   schedule?: typeof setTimeout,
 *   cancel?: typeof clearTimeout
 * }} [options]
 */
export function createUsageSourceWatcher(options = /** @type {any} */ ({})) {
  const {
    discoverRoots,
    onHint,
    ignorePath,
    debounceMs = 75,
    watchFile = watch,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = options;
  let active = false;
  let watchers = [];
  let debounceTimer = null;
  let refreshTail = Promise.resolve();

  function scheduleHint() {
    if (!active) return;
    if (debounceTimer !== null) return;
    debounceTimer = schedule(() => {
      debounceTimer = null;
      if (!active) return;
      Promise.resolve(onHint?.()).catch(() => {});
    }, debounceMs);
    debounceTimer?.unref?.();
  }

  function replaceWatchers(roots) {
    const next = [];
    for (const root of normalizeRoots(roots)) {
      try {
        const watcher = watchFile(root.path, { persistent: false, recursive: root.recursive }, (_event, filename) => {
          if (root.filename && filename && path.basename(String(filename)) !== root.filename) return;
          if (filename && ignorePath?.(path.resolve(root.path, String(filename)))) return;
          scheduleHint();
        });
        watcher.on?.("error", () => {
          const index = watchers.indexOf(watcher);
          if (index >= 0) watchers.splice(index, 1);
          watcher.close?.();
        });
        watcher.unref?.();
        next.push(watcher);
      } catch {
        // A missing or unsupported root is recovered by the periodic full check.
      }
    }
    for (const watcher of watchers) watcher.close?.();
    watchers = next;
  }

  function refresh() {
    if (!active) return Promise.resolve();
    refreshTail = refreshTail
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        const roots = await discoverRoots();
        if (!active) return;
        replaceWatchers(roots);
      });
    return refreshTail;
  }

  async function start() {
    if (active) return refresh();
    active = true;
    await refresh();
  }

  async function stop() {
    active = false;
    if (debounceTimer !== null) cancel(debounceTimer);
    debounceTimer = null;
    for (const watcher of watchers) watcher.close?.();
    watchers = [];
    await refreshTail.catch(() => {});
  }

  return {
    start,
    refresh,
    stop,
    get active() {
      return active;
    },
    get rootCount() {
      return watchers.length;
    },
  };
}
