import sqlite from 'node:sqlite';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.env.ARCH_STARTUP_SQL_DIR) {
  const directory = process.env.ARCH_STARTUP_SQL_DIR; mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `sql-${process.pid}.ndjson`), statements = new WeakMap();
  const aggregates = new Map(), json = { count: 0, totalMs: 0, maxMs: 0, characters: 0 };
  let buffer = '';
  const flush = () => { if (buffer) { appendFileSync(file, buffer); buffer = ''; } };
  const record = (method, sql, started, rows) => { const duration = performance.now() - started, key = method + '\0' + sql;
    const aggregate = aggregates.get(key) || { method, sql, count: 0, totalMs: 0, maxMs: 0 };
    aggregate.count++; aggregate.totalMs += duration; aggregate.maxMs = Math.max(aggregate.maxMs, duration); aggregates.set(key, aggregate);
    if (duration >= 5) buffer += JSON.stringify({ pid: process.pid, start: performance.timeOrigin + started, duration, method, sql, rows }) + '\n'; };
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function(sql, ...args) { const statement = Reflect.apply(prepare, this, [sql, ...args]); statements.set(statement, sql); return statement; };
  for (const name of ['get', 'all', 'run']) {
    const original = sqlite.StatementSync.prototype[name];
    sqlite.StatementSync.prototype[name] = function(...args) { const started = performance.now(); let result; try { result = Reflect.apply(original, this, args); return result; } finally { record(name, statements.get(this), started, Array.isArray(result) ? result.length : undefined); } };
  }
  const exec = sqlite.DatabaseSync.prototype.exec;
  sqlite.DatabaseSync.prototype.exec = function(sql, ...args) { const started = performance.now(); try { return Reflect.apply(exec, this, [sql, ...args]); } finally { record('exec', sql, started); } };
  const parse = JSON.parse;
  JSON.parse = function(...args) { const started = performance.now(); try { return Reflect.apply(parse, this, args); } finally { const ms = performance.now() - started; json.count++; json.totalMs += ms; json.maxMs = Math.max(json.maxMs, ms); json.characters += typeof args[0] === 'string' ? args[0].length : 0; } };
  const timer = setInterval(flush, 250); timer.unref(); process.once('exit', () => { flush(); writeFileSync(path.join(directory, `aggregate-${process.pid}.json`), JSON.stringify({ pid: process.pid, json, sql: [...aggregates.values()] })); });
}
