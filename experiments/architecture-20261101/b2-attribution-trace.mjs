import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import sqlite from 'node:sqlite';

const directory = process.env.Q0_TRACE_DIR;
const context = new AsyncLocalStorage();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let sequence = 0, buffer = '', fd, snapshotTaken = false;
const originals = { writeSync: fs.writeSync, readFileSync: fs.readFileSync };
const active = new Set();

function emit(record) {
  if (!directory) return;
  buffer += JSON.stringify({ pid: process.pid, ppid: process.ppid, at: Date.now(), ...record }) + '\n';
  if (buffer.length > 65536) flush();
}
function flush() { if (buffer && fd !== undefined) { originals.writeSync(fd, buffer); buffer = ''; } }
function memory(owner) {
  const m = process.memoryUsage();
  const quote = owner?.summaryProjectionCache?.quoteInputs;
  return { ...m, quoteRows: quote?.length ?? 0,
    quoteArrayBufferBytes: quote?.chunks?.reduce((n, c) => n + c.numbers.buffer.byteLength, 0) ?? 0,
    quoteBudgetAccountingBytes: quote?.bytes ?? 0,
    quoteStrings: quote?.values?.length ?? 0 };
}
function metadata(label, args, result, owner) {
  const m = {};
  if (label.includes('handleRequest')) m.url = String(args[0]?.url || '');
  if (/executor\.(request|handle|executeMessage)/.test(label)) {
    m.messageType = typeof args[0] === 'string' ? args[0] : args[0]?.type;
    m.messageId = args[0]?.id;
  }
  const filters = args.find(a => a && typeof a === 'object' && typeof a.preset === 'string');
  if (filters) m.preset = filters.preset;
  if (/store\.(groupedRange|periodAggregate)/.test(label)) m.dimension=args[0];
  if (/Fingerprint|replaceFile|appendFile|Prefix|\.proof\./.test(label) && typeof args[0] === 'string') m.source = args[0];
  if (typeof result?.readBytes === 'number') m.observedProofReadBytes = result.readBytes;
  if (typeof result?.parsedBytes === 'number') m.observedParsedBytes = result.parsedBytes;
  if (result?.validation?.kind) m.validationKind = result.validation.kind;
  if(label==='usage-summary-cache.get')m.cacheHit=Boolean(result);
  if(label==='usage-summary-cache.readSourceState') {
    m.publication=result?.publication?.signature;
    try {m.businessRevision=owner.source?.prepare('SELECT revision FROM usage_business_revision WHERE singleton=1').get()?.revision;}
    catch {m.businessRevisionUnavailable=true;}
  }
  if (label === 'store.syncRound') m.sourceWork = owner.lastSyncSourceWork;
  if (/quote\.(finish|discard)/.test(label)) {
    m.quoteRows = owner.length; m.quoteArrayBufferBytes = owner.chunks.reduce((n,c)=>n+c.numbers.buffer.byteLength,0);
    m.quoteBudgetAccountingBytes = owner.bytes; m.quoteStrings = owner.values.length;
  }
  return m;
}
function begin(label, args, owner) {
  const parent = context.getStore();
  const span = { id: `${process.pid}:${++sequence}`, parentId: parent?.id ?? null, label,
    start: performance.timeOrigin + performance.now(), cpu: process.cpuUsage(), memoryBefore: memory(owner),
    counters: {}, io: { fileHandleReadBytes: 0, streamDeliveredBytes: 0, readFileReturnedBytes: 0 } };
  active.add(span);
  if (label==='usage-session-members.close' && owner?.database) {
    const pages=owner.database.prepare('PRAGMA page_count').get().page_count;
    const pageSize=owner.database.prepare('PRAGMA page_size').get().page_size;
    span.temporarySqlite={pages,pageSize,logicalBytes:pages*pageSize,databaseList:owner.database.prepare('PRAGMA database_list').all()};
  }
  if(label==='usage-quota-store.dropObservationSource') {
    const pages=args[0].prepare('PRAGMA temp.page_count').get().page_count;
    const pageSize=args[0].prepare('PRAGMA temp.page_size').get().page_size;
    span.temporarySqlite={pages,pageSize,logicalBytes:pages*pageSize,schema:'temp'};
  }
  span.finish = (status, result) => {
    if (!active.delete(span)) return;
    const cpu = process.cpuUsage(span.cpu);
    emit({ type: 'span', id: span.id, parentId: span.parentId, label, start: span.start,
      duration: performance.timeOrigin + performance.now() - span.start,
      cpuMs: (cpu.user + cpu.system) / 1000, status,
      memoryBefore: span.memoryBefore, memoryAfter: memory(owner), counters: span.counters, io: span.io, temporarySqlite:span.temporarySqlite,
      ...metadata(label, args, result, owner) });
  };
  return span;
}
function counted(fn, name) {
  return function(...args) {
    const span = context.getStore();
    if (!span) return Reflect.apply(fn, this, args);
    const start = performance.now();
    try { return Reflect.apply(fn, this, args); }
    finally { const c = span.counters[name] ??= { calls: 0, ms: 0 }; c.calls++; c.ms += performance.now() - start; }
  };
}
export function wrap(fn, label) {
  if (typeof fn !== 'function' || !directory) return fn;
  if (/GeneratorFunction$/.test(fn.constructor?.name)) return fn;
  return function(...args) {
    const span = begin(label, args, this);
    return context.run(span, () => {
      try {
        const value = Reflect.apply(fn, this, args);
        if (value && typeof value.then === 'function') {
          value.then(r => span.finish('ok', r), () => span.finish('error'));
          return value;
        }
        if (/pricing\.createEventPricing$/.test(label) && value?.estimate) value.estimate = counted(value.estimate, 'price.estimate');
        if (/createFusedSummary/.test(label) && value?.add) value.add = counted(value.add, 'group.add');
        if (/createCostEstimateAccumulator$/.test(label) && value?.add) value.add = counted(value.add, 'cost.add');
        if (label==='usage-session-members.createSet' && value?.add) value.add=counted(value.add,'sessionMember.add');
        span.finish('ok', value);
        if (process.env.Q0_HEAP_SNAPSHOT === '1' && !snapshotTaken &&
          ((/store\.summarizeInReadTransactionCore$/.test(label) && args[0]?.preset === 'all') ||
           (label==='server.sendJson' && args[2]?.summary?.range?.preset==='all'))) {
          snapshotTaken = true; emit({type:'snapshot-start'}); flush();
          v8.writeHeapSnapshot(path.join(directory, `heap-${process.pid}.heapsnapshot`));
          emit({type:'snapshot-end'});
        }
        return value;
      } catch (error) { span.finish('error'); throw error; }
    });
  };
}
function iterator(fn, label) {
  return function(...args) {
    const span = context.getStore();
    const it = Reflect.apply(fn, this, args);
    if (!span) return it;
    return { [Symbol.iterator]() {return this;}, next(...values) {
      const start = performance.now();
      try { const r = it.next(...values); if (!r.done) { const c=span.counters[label] ??= {calls:0,ms:0}; c.calls++; c.ms += performance.now()-start; } return r; }
      catch(e) {throw e;}
    }, return(...values) {return it.return ? it.return(...values) : {done:true};}, throw(...values) {return it.throw(...values);} };
  };
}
function io(kind, bytes, span=context.getStore()) { if(span && Number.isFinite(bytes)) span.io[kind] += bytes; }
function installIo() {
  const open = fsp.open;
  fsp.open = async function(...args) {
    const handle = await Reflect.apply(open, this, args), read = handle.read;
    handle.read = async function(...params) {
      const span = context.getStore(), result = await Reflect.apply(read, this, params);
      io('fileHandleReadBytes', result.bytesRead, span); return result;
    };
    return handle;
  };
  const readFile = fsp.readFile;
  fsp.readFile = async function(...args) {
    const span = context.getStore(), result = await Reflect.apply(readFile, this, args);
    io('readFileReturnedBytes', typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength, span); return result;
  };
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function(...args) {
    const span = context.getStore(), stream = Reflect.apply(createReadStream, this, args), emitOriginal = stream.emit;
    stream.emit = function(event, ...values) { if(event==='data') io('streamDeliveredBytes', values[0]?.byteLength, span); return Reflect.apply(emitOriginal,this,[event,...values]); };
    return stream;
  };
  syncBuiltinESMExports();
}


if(directory) {
  fs.mkdirSync(directory,{recursive:true});
  fd=fs.openSync(path.join(directory,`q0-trace-${process.pid}.ndjson`),'wx');
  emit({type:'start',argv:process.execArgv,memory:memory(),cpuUsage:process.cpuUsage()});
  globalThis.__q0={wrap,iterator,note:record=>emit({...record,parentId:context.getStore()?.id})}; installIo();
  const exec=sqlite.DatabaseSync.prototype.exec;
  sqlite.DatabaseSync.prototype.exec=function(sql,...args) {
    const type=/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.exec(String(sql))?.[1]?.toUpperCase();
    return type ? wrap(exec,'sql.'+type).apply(this,[sql,...args]) : exec.apply(this,[sql,...args]);
  };
  const sources=JSON.parse(originals.readFileSync(process.env.Q0_SOURCE_MAP,'utf8'));
  registerHooks({load(url,ctx,next){
    const r=next(url,ctx); if(!url.startsWith('file:'))return r;
    const file=path.relative(root,fileURLToPath(url)).split(path.sep).join('/');
    if(!sources[file])return r;
    return {...r,source:sources[file]};
  }});
  const timer=setInterval(()=>{emit({type:'sample',memory:memory()});flush();},250);timer.unref();
  process.once('exit',()=>{for(const s of active)s.finish('unsettled');emit({type:'exit',memory:memory(),cpuUsage:process.cpuUsage(),resourceUsage:process.resourceUsage()});flush();fs.closeSync(fd);});
}
