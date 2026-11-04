import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

if (process.env.ARCH_DSH_BASELINE_FILE) {
  const source = readFileSync(process.env.ARCH_DSH_BASELINE_FILE, 'utf8');
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      return url.endsWith('/src/dsh-usage.js') ? { ...loaded, source } : loaded;
    },
  });
}
