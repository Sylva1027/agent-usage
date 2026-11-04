import { USAGE_FIELDS } from "./protocol.mjs";

export class AggregateOverflowError extends Error {
  constructor() {
    super("aggregate exceeds the JSON safe-integer limit");
    this.name = "AggregateOverflowError";
  }
}

function emptyTotals() {
  return { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
}

function addTotals(target, value) {
  for (const field of USAGE_FIELDS) {
    const next = target[field] + value[field];
    if (!Number.isSafeInteger(next)) {
      throw new AggregateOverflowError();
    }
    target[field] = next;
  }
  return target;
}

function sessionKey(event) {
  return event.sessionId;
}

export function projectionLabel(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupEvents(events, selectName) {
  const groups = new Map();
  for (const event of events) {
    const name = selectName(event);
    let group = groups.get(name);
    if (!group) {
      group = { name, count: 0, sessions: new Set(), total: emptyTotals() };
      groups.set(name, group);
    }
    group.count += 1;
    group.sessions.add(sessionKey(event));
    addTotals(group.total, event.total);
  }
  return [...groups.values()]
    .map(({ name, count, sessions, total }) => ({ name, count, sessions: sessions.size, total }))
    .sort(
      (left, right) =>
        (left.total.total < right.total.total ? 1 : left.total.total > right.total.total ? -1 : 0) ||
        compareNames(left.name, right.name),
    );
}

export function aggregateEvents(events) {
  const totals = emptyTotals();
  const sessions = new Set();
  const homes = new Set();
  const timelineGroups = new Map();

  for (const event of events) {
    addTotals(totals, event.total);
    sessions.add(sessionKey(event));
    homes.add(event.homeId);

    const day = new Date(event.timestamp).toISOString().slice(0, 10);
    let group = timelineGroups.get(day);
    if (!group) {
      group = { name: day, count: 0, sessions: new Set(), total: emptyTotals() };
      timelineGroups.set(day, group);
    }
    group.count += 1;
    group.sessions.add(sessionKey(event));
    addTotals(group.total, event.total);
  }

  return {
    eventCount: events.length,
    sessionCount: sessions.size,
    homeCount: homes.size,
    totals,
    models: groupEvents(events, (event) => projectionLabel(event.model, "Unknown model")),
    channels: groupEvents(events, (event) => projectionLabel(event.channel, "Unknown channel")),
    projects: groupEvents(events, (event) => projectionLabel(event.cwd, "Unknown cwd")),
    repositories: groupEvents(events, (event) => projectionLabel(event.repositoryKey, "Unknown repository")),
    timeline: [...timelineGroups.values()]
      .map(({ name, count, sessions: groupSessions, total }) => ({
        name,
        count,
        sessions: groupSessions.size,
        total,
      }))
      .sort((left, right) => compareNames(left.name, right.name)),
  };
}
