import fs from 'node:fs';
import {registerHooks} from 'node:module';
registerHooks({load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith('/src/usage-store.js')) return {...result, source:fs.readFileSync(new URL('./preimage/src/usage-store.js', import.meta.url),'utf8')};
  return result;
}});
