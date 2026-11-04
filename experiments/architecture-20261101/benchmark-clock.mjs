// Child-only clock control; worker threads inherit --import. Timers remain real.
if (process.env.ARCH_BENCH_NOW) {
  const OriginalDate = Date;
  const fixed = OriginalDate.parse(process.env.ARCH_BENCH_NOW);
  if (!Number.isFinite(fixed)) throw new Error('Invalid ARCH_BENCH_NOW');
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}
