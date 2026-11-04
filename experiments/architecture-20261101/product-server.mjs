import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyBackendAggregates,
  backendQueryForProjection,
  productProjection,
} from './compat.mjs';
import { ProductPublisher } from './product-publisher.mjs';
import { getPricingCatalog } from '../../src/pricing.js';

const DEFAULT_PUBLIC_ROOT = fileURLToPath(new URL('../../public/', import.meta.url));
const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class BackendRequestError extends HttpError {
  constructor(status, message, data) {
    super(status, message, data?.code);
    this.data = data;
  }
}

async function defaultBackendRequest(backend, route, body) {
  const response = await fetch(backend + route, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackendRequestError(502, `Backend returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new BackendRequestError(response.status, value?.error || `Backend returned ${response.status}`, value);
  }
  return { value, bytes: Buffer.byteLength(text) };
}

function resultValue(result) {
  if (result && Object.hasOwn(result, 'value')) return result;
  return { value: result, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

function clockFrom(now) {
  if (now === undefined) return () => new Date();
  if (typeof now === 'function') {
    return () => {
      const value = new Date(now());
      if (Number.isNaN(value.getTime())) throw new RangeError('now() returned an invalid date');
      return value;
    };
  }
  const fixed = new Date(now);
  if (Number.isNaN(fixed.getTime())) throw new RangeError('now must be a valid date');
  return () => new Date(fixed);
}

function filtersFrom(url) {
  const filters = Object.fromEntries(url.searchParams);
  filters.excludeHomes = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
  filters.excludeHomes.push(...url.searchParams.getAll('excludeHome'));
  if (url.searchParams.has('excludeHomes')) {
    filters.excludeHomes.push(...url.searchParams.get('excludeHomes').split(',').filter(Boolean));
  }
  filters.excludeHomes = [...new Set(filters.excludeHomes)];
  delete filters.exclude;
  delete filters.excludeHome;
  delete filters.freeze;
  delete filters.snapshot;
  return filters;
}

function timingHeader(timing) {
  return ['feed', 'projection', 'core', 'response']
    .map(name => `${name};dur=${Number(timing[name] || 0).toFixed(3)}`)
    .join(', ');
}

function sendJson(response, status, value, timing, publisher) {
  const started = performance.now();
  const body = Buffer.from(JSON.stringify(value));
  timing.response += performance.now() - started;
  publisher.recordResponse(body.length);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'server-timing': timingHeader(timing),
  });
  response.end(body);
}

function queryRoute(query, snapshot) {
  const params = new URLSearchParams(query);
  if (snapshot !== null) params.set('snapshot', snapshot);
  return `/api/query?${params}`;
}

export async function createProductServer({
  backend,
  mode = 'incremental',
  now,
  request,
  publicRoot = DEFAULT_PUBLIC_ROOT,
  pricingCatalog = getPricingCatalog,
} = {}) {
  if (!['incremental', 'published', 'legacy'].includes(mode)) throw new RangeError(`Unknown mode: ${mode}`);
  if (!request && (typeof backend !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(backend))) {
    throw new Error('backend must be a local prototype URL');
  }
  const clock = clockFrom(now);
  const backendRequest = request || ((route, body) => defaultBackendRequest(backend, route, body));
  const publisher = new ProductPublisher({ request: backendRequest });
  // shortcut: experimental view bindings live for this process; bound retention before production.
  const frozen = new Map();

  async function call(route, body) {
    return resultValue(await backendRequest(route, body));
  }

  async function freezeUsage() {
    const asOf = clock();
    const catalog = structuredClone(pricingCatalog());
    const result = await call('/api/freeze', {});
    const backendSnapshot = String(result.value?.snapshot);
    if (backendSnapshot === 'undefined' || backendSnapshot === 'null') {
      throw new Error('Backend freeze returned no snapshot');
    }
    let viewId;
    do {
      viewId = `view-${randomUUID()}`;
    } while (frozen.has(viewId));
    frozen.set(viewId, {
      backendSnapshot,
      asOf,
      pricingCatalog: catalog,
      revision: null,
    });
    return viewId;
  }

  function frozenBinding(snapshot) {
    const binding = frozen.get(String(snapshot));
    if (!binding) throw new HttpError(410, 'Snapshot is not bound by this product server', 'SNAPSHOT_EXPIRED');
    return binding;
  }

  async function publishedUsage(filters, snapshot, timing) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const binding = snapshot === null ? null : frozenBinding(snapshot);
      const backendSnapshot = binding?.backendSnapshot || null;
      const feedStarted = performance.now();
      const state = await publisher.sync(backendSnapshot);
      timing.feed += performance.now() - feedStarted;
      const revision = state.revision;
      const carrier = mode === 'incremental' ? publisher.sourceCarrier(backendSnapshot) : publisher.carrier(backendSnapshot);
      if (binding && binding.revision !== null && binding.revision !== revision) {
        throw new HttpError(502, 'Frozen facts revision changed unexpectedly', 'REVISION_MISMATCH');
      }
      if (binding && binding.revision === null) binding.revision = revision;
      const asOf = binding?.asOf || clock();
      const catalog = binding?.pricingCatalog || pricingCatalog();
      const projectionStarted = performance.now();
      const project = mode === 'incremental' ? publisher.projectSources.bind(publisher) : publisher.projectCarrier.bind(publisher);
      let projected = project(carrier, filters, {
        asOf,
        pricingCatalog: catalog,
        snapshot,
      });
      timing.projection += performance.now() - projectionStarted;

      const query = backendQueryForProjection(projected, filters);
      if (query && mode !== 'incremental') {
        const queryStarted = performance.now();
        const result = await call(queryRoute(query, backendSnapshot));
        const queryMs = performance.now() - queryStarted;
        timing.core += queryMs;
        publisher.recordQuery(queryMs);
        if (result.value?.revision !== revision) {
          if (snapshot === null && attempt < 2) continue;
          throw new HttpError(502, 'Backend query revision does not match published facts', 'REVISION_MISMATCH');
        }
        projected = applyBackendAggregates(projected, result.value);
      }
      return {
        projected,
        revision,
        snapshot,
      };
    }
    throw new HttpError(502, 'Published facts did not settle', 'REVISION_MISMATCH');
  }

  async function legacyUsage(filters, snapshot, timing) {
    const binding = snapshot === null ? null : frozenBinding(snapshot);
    const asOf = binding?.asOf || clock();
    const catalog = binding?.pricingCatalog || pricingCatalog();
    const route = '/api/report' + (
      binding === null ? '' : `?snapshot=${encodeURIComponent(binding.backendSnapshot)}`
    );
    const started = performance.now();
    const result = await call(route);
    timing.core += performance.now() - started;
    const carrier = result.value;
    if (binding && binding.revision !== null && binding.revision !== carrier.revision) {
      throw new HttpError(502, 'Frozen report revision changed unexpectedly', 'REVISION_MISMATCH');
    }
    if (binding && binding.revision === null) binding.revision = carrier.revision;
    const projectionStarted = performance.now();
    const projected = productProjection(carrier, { ...filters, now: asOf, pricingCatalog: catalog });
    timing.projection += performance.now() - projectionStarted;
    publisher.counters.projectionRequests += 1;
    publisher.counters.projectionCacheMisses += 1;
    publisher.counters.projectionMs += timing.projection;
    return { projected, revision: carrier.revision, snapshot };
  }

  const server = createServer(async (incoming, response) => {
    const timing = { feed: 0, projection: 0, core: 0, response: 0 };
    try {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      if (incoming.method !== 'GET') {
        sendJson(response, 405, { error: 'This prototype exposes read-only product views' }, timing, publisher);
        return;
      }
      if (url.pathname === '/api/diagnostics') {
        sendJson(response, 200, publisher.diagnostics(mode), timing, publisher);
        return;
      }
      if (url.pathname === '/api/status') {
        const state = await call('/api/status');
        const fingerprint = String(state.value.revision);
        sendJson(response, 200, {
          ...state.value,
          fingerprint,
          changed: url.searchParams.get('since') !== fingerprint,
          checkedAt: clock().toISOString(),
        }, timing, publisher);
        return;
      }
      if (url.pathname === '/api/usage' || url.pathname === '/api/summary') {
        let snapshot = url.searchParams.get('snapshot');
        if (!snapshot && url.searchParams.get('freeze') === '1') snapshot = await freezeUsage();
        if (snapshot !== null) frozenBinding(snapshot);
        const filters = filtersFrom(url);
        const usage = mode === 'legacy'
          ? await legacyUsage(filters, snapshot, timing)
          : await publishedUsage(filters, snapshot, timing);
        const projected = usage.projected;
        sendJson(response, 200, {
          ...projected,
          metadata: { ...projected.metadata, imports: [] },
          fingerprint: String(usage.revision),
          snapshotId: usage.snapshot,
          checkedAt: projected.summary.generatedAt,
        }, timing, publisher);
        return;
      }
      if (url.pathname === '/api/pricing') {
        sendJson(response, 200, {
          ...getPricingCatalog(),
          automatic: { enabled: false },
          usageCoverage: {},
          modelActivity: {},
        }, timing, publisher);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Endpoint outside the prototype query slice' }, timing, publisher);
        return;
      }

      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.resolve(publicRoot, relative);
      if (target !== path.resolve(publicRoot) && !target.startsWith(path.resolve(publicRoot) + path.sep)) {
        sendJson(response, 403, { error: 'Invalid asset path' }, timing, publisher);
        return;
      }
      const bytes = await readFile(target);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(target)] || 'application/octet-stream',
        'server-timing': timingHeader(timing),
      });
      response.end(bytes);
    } catch (error) {
      sendJson(response, error.code === 'ENOENT' ? 404 : error.status || error.statusCode || 500, {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.data && error.data.code ? { backendCode: error.data.code } : {}),
      }, timing, publisher);
    }
  });
  server.productPublisher = publisher;
  return server;
}

async function runCli() {
  const options = parseArgs({
    options: {
      backend: { type: 'string' },
      port: { type: 'string', default: '0' },
      mode: { type: 'string', default: 'incremental' },
      now: { type: 'string' },
    },
  }).values;
  if (!options.backend || !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.backend)) {
    throw new Error('--backend must be a local prototype URL');
  }
  const port = Number(options.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be between 0 and 65535');
  const server = await createProductServer({
    backend: options.backend,
    mode: options.mode,
    now: options.now,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      port: server.address().port,
      backend: options.backend,
      mode: options.mode,
      layer: 'shared-node-business-formulas',
    }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
