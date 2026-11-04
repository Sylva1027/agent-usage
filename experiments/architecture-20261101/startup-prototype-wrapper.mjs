import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createProductServer } from './product-server.mjs';
import { launch } from './runner.mjs';
import { publishFormalSources } from './startup-prototype-adapter.mjs';

export function wrapStartupServer(sourceServer, options) {
  const gate = sourceServer[Symbol.for('architecture.startup.gate')];
  if (!gate) throw Error('Formal source gate is required');
  const variant = process.env.ARCH_STARTUP_VARIANT, directory = process.env.ARCH_STARTUP_PROTO_DIR;
  if (!variant || !directory) throw Error('Prototype variant and isolated directory required');
  const output = process.env.ARCH_STARTUP_RESULT_DIR;
  let engine, product, sourceUrl, productUrl, active, initialized = false;
  const record = data => appendFile(path.join(output, 'prototype-stages.ndjson'), JSON.stringify({ at: Date.now(), ...data }) + '\n');
  const ready = (async () => {
    sourceServer.listen(0, '127.0.0.1'); await once(sourceServer, 'listening');
    sourceUrl = 'http://127.0.0.1:' + sourceServer.address().port;
    const backendMemory = Number(process.env.ARCH_STARTUP_ENGINE_MEMORY_MB || '512');
    if (!Number.isSafeInteger(backendMemory) || backendMemory < 64) throw Error('Invalid experimental backend memory limit');
    engine = await launch(variant, directory, [], { env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ` --max-old-space-size=${backendMemory} --report-on-fatalerror --report-directory=` + JSON.stringify(output) } });
    engine.child.on('exit', (code, signal) => { void record({ stage: 'backend-exit', code, signal, stderr: engine.stderr() }); });
    product = await createProductServer({ backend: engine.baseUrl, pricingCatalog: gate.pricingCatalog });
    product.listen(0, '127.0.0.1'); await once(product, 'listening'); productUrl = 'http://127.0.0.1:' + product.address().port;
  })();
  const sourceGate = async check => {
    if (initialized && !check) return;
    if (active) return active;
    active = (async () => {
      await ready; const start = performance.now(); await gate.pricingReady; const status = await gate.loadUsageStore({ check });
      await record({ stage: 'formal-gate', ms: performance.now() - start, updatedFiles: status.updatedFileCount });
      await record({ stage: 'adapter', ...await publishFormalSources({ backend: engine.baseUrl, directory, options, gate }) });
      initialized = true;
    })().finally(() => { active = null; }); return active;
  };
  const proxy = createServer(async (req, res) => {
    try {
      await ready;
      const usage = /^\/api\/(usage|status|summary)(\?|$)/.test(req.url);
      if (usage) await sourceGate(new URL(req.url, 'http://127.0.0.1').searchParams.get('skipCheck') !== '1');
      const target = req.url.startsWith('/internal/') ? sourceUrl : productUrl;
      const upstream = httpRequest(new URL(req.url, target), { method: req.method, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
      upstream.on('error', error => { res.writeHead(502); res.end(JSON.stringify({ error: error.message })); }); req.pipe(upstream);
    } catch (error) { await record({ stage: 'error', error: error.stack }); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  const originalClose = proxy.close.bind(proxy);
  proxy.close = callback => {
    const promise = (async () => { await ready.catch(() => {}); await sourceServer.close(); if (product) await new Promise(resolve => product.close(resolve)); await engine?.stop(); if (engine) await record({ stage: 'backend-stderr', stderr: engine.stderr() }); await new Promise(resolve => originalClose(resolve)); })();
    if (callback) promise.then(() => callback(), callback); return callback ? proxy : promise;
  };
  return proxy;
}
