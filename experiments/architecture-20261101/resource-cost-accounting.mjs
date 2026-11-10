import { resourceSnapshotRows } from "./resource-identity-analysis.mjs";

const fields = ["cpuSeconds", "logicalReadBytes", "logicalWriteBytes"];

// Cumulative counters include the first observation; an absent delta is not a missing counter.
export function createResourceCostLedger() {
  const members = new Map();
  let samples = 0, firstAtMs = null, lastAtMs = null;
  return {
    add(sample) {
      samples++;
      firstAtMs ??= sample.atUnixMs;
      lastAtMs = sample.atUnixMs;
      for (const row of [...resourceSnapshotRows(sample), ...(sample.costFinals ?? [])].filter(value => value.role === "service")) {
        const key = `${row.pid}|${row.startTimeUtc}`;
        let member = members.get(key);
        if (!member) {
          member = { pid: row.pid, startTimeUtc: row.startTimeUtc, firstAtMs: sample.atUnixMs,
            lastAtMs: sample.atUnixMs, final: false, missing: [], values: {} };
          members.set(key, member);
        }
        member.lastAtMs = sample.atUnixMs;
        member.final ||= row.finalCounters === true;
        for (const field of fields) {
          const available = field === "cpuSeconds" ? row.cpuAvailable : row.ioAvailable;
          const value = row[field];
          if (!available || !Number.isFinite(value) || value < 0 || !row.startTimeUtc ||
            value < (member.values[field] ?? 0)) {
            if (!member.missing.includes(field)) member.missing.push(field);
          } else member.values[field] = value;
        }
      }
    },
    result({ closed = false } = {}) {
      const processes = [...members.values()];
      const missing = processes.filter(row => row.missing.length);
      const missingFinal = closed ? processes.filter(row => !row.final) : [];
      const totals = Object.fromEntries(fields.map(field => [field,
        processes.some(row => row.missing.includes(field)) ? null : processes.reduce((sum, row) => sum + (row.values[field] ?? 0), 0)]));
      return { samples, firstAtMs, lastAtMs, totals, processes, missing, missingFinal,
        complete: samples > 0 && !missing.length && !missingFinal.length,
        scope: "cumulative service counters by PID and creation time; complete lifetime totals require final counters for every observed member" };
    },
  };
}
