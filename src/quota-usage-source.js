function latestState(entries = [], time) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return entries[low - 1];
}

export function quotaSourceResolver(records, evidence) {
  const threads = new Map();
  const accounts = new Map();
  for (const row of records) {
    const key = JSON.stringify([row.homeId, row.sessionId]);
    const entries = threads.get(key) || [];
    const entry = {
      time: Number(row.timestampMs ?? Date.parse(row.timestamp)),
      source: row.quotaSource || "unknown",
      until: Number(row.quotaSourceUntil || 0),
    };
    if (!Number.isFinite(entry.time)) continue;
    entries.push(entry);
    threads.set(key, entries);
    if (["credits", "plan"].includes(entry.source)) {
      const states = accounts.get(row.homeId) || [];
      states.push(entry);
      accounts.set(row.homeId, states);
    }
  }
  for (const entries of threads.values()) entries.sort((a, b) => a.time - b.time);
  for (const entries of accounts.values()) entries.sort((a, b) => a.time - b.time);
  return (homeId, sessionId, time, recordedSource = "unknown") => {
    const entry = latestState(threads.get(JSON.stringify([homeId, sessionId])), time);
    let source = recordedSource !== "unknown" ? recordedSource : entry?.source || "unknown";
    if (source === "credits" && entry?.until <= time) source = "unknown";
    const state = latestState(accounts.get(homeId), time);
    source = evidence?.resolve(homeId, sessionId, time, source) || source;
    if (!["api", "external"].includes(source) && state?.source === "credits" && time < state.until) source = "credits";
    return source;
  };
}
