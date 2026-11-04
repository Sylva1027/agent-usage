import { mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import path from 'node:path';
if (process.env.ARCH_STARTUP_RESULT_DIR) {
  const directory = process.env.ARCH_STARTUP_RESULT_DIR;
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `process-${process.pid}.ndjson`);
  const record = (type, extra = {}) => appendFileSync(file, JSON.stringify({ type, pid: process.pid, ppid: process.ppid, at: Date.now(), argv: process.argv, execArgv: process.execArgv, heapLimit: getHeapStatistics().heap_size_limit, ...process.memoryUsage(), ...extra }) + '\n');
  record('start');
  const timer = setInterval(() => record('memory'), 1000); timer.unref();
  process.on('uncaughtExceptionMonitor', error => record('uncaught', { error: error.stack }));
  process.once('exit', code => record('exit', { code, cpu: process.cpuUsage(), resource: process.resourceUsage() }));
  if (process.env.ARCH_CAPTURE_STDERR === '1' || process.env.ARCH_RESOURCE_SAMPLER === '1') {
    for (const method of ['spawn', 'fork']) {
      const original = childProcess[method];
      childProcess[method] = function(command, args, options = {}) {
        const fd = openSync(path.join(directory, `child-stderr-${process.pid}.log`), 'a');
        try {
          const stdio = options.stdio === 'ignore' ? ['ignore', 'ignore', fd] : Array.isArray(options.stdio) ? options.stdio.map((value,index) => index === 2 && value === 'ignore' ? fd : value) : options.stdio;
          return Reflect.apply(original, this, [command, args, { ...options, stdio }]);
        } finally { closeSync(fd); }
      };
    }
    syncBuiltinESMExports();
  }
}
