/** Fold M6.1 rollout projections into stable per-turn ledgers. */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceOrder(a, b) {
  return (
    compareText(a.sourcePath ?? "", b.sourcePath ?? "") ||
    (Number(a.lineNumber) || 0) - (Number(b.lineNumber) || 0) ||
    a.inputOrder - b.inputOrder
  );
}

function tupleKey(parts) {
  return JSON.stringify(parts);
}

function valuesOf(records, field, normalize = (value) => value) {
  const values = new Map();
  for (const record of records) {
    const value = record[field];
    if (value === null || value === undefined || value === "") continue;
    const normalized = normalize(value);
    if (normalized !== null && normalized !== undefined) values.set(JSON.stringify(normalized), normalized);
  }
  return [...values.values()];
}

function resolveField(records, field, normalize) {
  const values = valuesOf(records, field, normalize);
  return { value: values.length === 1 ? values[0] : null, conflict: values.length > 1 };
}

function timestampValue(value) {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { key: `ms:${ms}`, ms } : { key: `raw:${value}`, ms: null };
}

function resolveTimestamp(records) {
  const values = new Map();
  for (const record of records) {
    const value = timestampValue(record.timestamp);
    if (value) values.set(value.key, value);
  }
  const distinct = [...values.values()];
  return { value: distinct.length === 1 ? distinct[0].ms : null, conflict: distinct.length > 1 };
}

function createTurn(homeId, threadId, turnId) {
  return {
    homeId,
    threadId,
    turnId,
    turnKey: tupleKey([homeId, threadId, turnId]),
    model: null,
    effort: null,
    modelValues: [],
    effortValues: [],
    modelEvidence: null,
    agentKind: "unknown",
    requests: [],
    responses: [],
    items: [],
    taskComplete: null,
    hasTaskComplete: false,
    requestCount: 0,
    itemCount: 0,
    requestOutputSum: null,
    lastTurnOutputTokens: null,
    requestOrderBasis: "unavailable",
    crossCheckState: "unavailable",
    requestSumMismatchCount: 0,
    recordConflictCount: 0,
    flags: new Set(),
    diagnostics: { unkeyableRequestCount: 0, unkeyableItemCount: 0, unkeyableRequests: [] },
    conflictKeys: new Set(),
    _contexts: [],
    _terminals: [],
  };
}

function markConflict(turn, key) {
  turn.flags.add("RECORD_CONFLICT");
  turn.conflictKeys.add(key);
}

function turnKey(homeId, threadId, turnId) {
  return tupleKey([homeId, threadId, turnId]);
}

function sortRequests(requests) {
  // A partial-time comparator can be non-transitive; use timestamp ordering
  // only when every request has one, otherwise use the stable source order.
  const hasAllTimes = requests.length > 0 && requests.every((request) => Number.isFinite(request.timestampMs));
  const ordered = [...requests].sort((a, b) => {
    if (hasAllTimes && a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    return (
      compareText(a.sourcePath ?? "", b.sourcePath ?? "") || (Number(a.lineNumber) || 0) - (Number(b.lineNumber) || 0)
    );
  });
  return {
    ordered,
    basis: requests.length === 0 ? "unavailable" : hasAllTimes ? "timestamp" : "source_path_line_fallback",
  };
}

function responseEventKind(record) {
  if (record.kind === "response_item") {
    if (record.responseItemType === "message" && record.role === "assistant") return "text";
    if (record.responseItemType === "reasoning") return "reasoning";
    if (record.responseItemType === "function_call" || record.responseItemType === "custom_tool_call") return "tool";
    return null;
  }
  if (record.kind === "item_completed") {
    if (record.itemType === "AgentMessage") return "text";
    if (record.itemType === "Reasoning") return "reasoning";
  }
  return null;
}

/**
 * Fold the `{ records, stats }` values returned by M6.1. Identity strings are
 * case-sensitive; file and line order are the deterministic fallback when a
 * request timestamp is missing.
 *
 * @param {string} homeId
 * @param {Array<{records: Array<Record<string, unknown>>}>} rollouts
 * @returns {{turns: Array<Record<string, unknown>>, stats: Record<string, unknown>}}
 */
export function foldCodexRolloutMetadata(homeId, rollouts) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!Array.isArray(rollouts)) throw new TypeError("Codex rollouts must be an array");

  const stats = {
    recordsSeen: 0,
    orphanRecords: 0,
    sessionMetaIdentityConflicts: 0,
    unkeyableRequestRecords: 0,
    unkeyableItemRecords: 0,
    unassignedRequests: 0,
    conflictingRequests: 0,
    requestCount: 0,
    responseCount: 0,
    itemCount: 0,
    turnCount: 0,
    requestSumMismatchCount: 0,
    recordConflictCount: 0,
  };
  /** @type {Array<Record<string, unknown> & { inputOrder: number }>} */
  const records = [];
  let inputOrder = 0;
  for (const rollout of rollouts) {
    if (!isRecord(rollout) || !Array.isArray(rollout.records))
      throw new TypeError("Each Codex rollout must contain records");
    for (const record of rollout.records) {
      if (!isRecord(record)) throw new TypeError("Codex rollout records must be objects");
      records.push({ ...record, inputOrder: inputOrder++ });
    }
  }
  records.sort(sourceOrder);
  stats.recordsSeen = records.length;

  const turns = new Map();
  const threadIsSubagent = new Map();
  const requestGroups = new Map();
  const itemGroups = new Map();
  const responseEventGroups = new Map();
  const requestObservationsByStream = new Map();
  const responseOwners = new Map();
  const orphanByKind = new Map();
  const getTurn = (threadId, turnId) => {
    const key = turnKey(homeId, threadId, turnId);
    if (!turns.has(key)) turns.set(key, createTurn(homeId, threadId, turnId));
    return turns.get(key);
  };
  const orphan = (kind) => {
    stats.orphanRecords += 1;
    orphanByKind.set(kind, (orphanByKind.get(kind) ?? 0) + 1);
  };

  for (const record of records) {
    if (
      record.kind !== "token_usage_record" ||
      typeof record.threadId !== "string" ||
      record.threadId === "" ||
      typeof record.turnId !== "string" ||
      record.turnId === "" ||
      typeof record.responseId !== "string" ||
      record.responseId === ""
    ) {
      continue;
    }
    const key = tupleKey([record.sourcePath ?? "", record.threadId, record.turnId]);
    if (!requestObservationsByStream.has(key)) requestObservationsByStream.set(key, []);
    requestObservationsByStream.get(key).push({
      sourceOrder: record.inputOrder,
      responseId: record.responseId,
    });
  }
  for (const observations of requestObservationsByStream.values()) {
    observations.sort((left, right) => left.sourceOrder - right.sourceOrder);
  }
  const responseIdAfter = (record) => {
    const observations = requestObservationsByStream.get(
      tupleKey([record.sourcePath ?? "", record.threadId, record.turnId]),
    );
    return observations?.find((observation) => observation.sourceOrder > record.inputOrder)?.responseId ?? null;
  };

  for (const record of records) {
    if (record.kind === "session_meta") {
      if (record.threadEvidenceConflict) stats.sessionMetaIdentityConflicts += 1;
      if (typeof record.threadId === "string" && record.threadId !== "" && record.explicitSubagent === true) {
        threadIsSubagent.set(record.threadId, true);
      }
      continue;
    }

    if (record.kind === "token_usage_record") {
      if (typeof record.threadId !== "string" || record.threadId === "") {
        orphan(record.kind);
        continue;
      }
      const turn =
        typeof record.turnId === "string" && record.turnId !== "" ? getTurn(record.threadId, record.turnId) : null;
      if (typeof record.responseId !== "string" || record.responseId === "") {
        stats.unkeyableRequestRecords += 1;
        if (turn) {
          turn.diagnostics.unkeyableRequestCount += 1;
          turn.diagnostics.unkeyableRequests.push({
            outputTokens: record.outputTokens ?? null,
            turnOutputTokens: record.turnOutputTokens ?? null,
            timestampMs: timestampValue(record.timestamp)?.ms ?? null,
            sourcePath: record.sourcePath ?? "",
            lineNumber: Number(record.lineNumber) || 0,
          });
        } else orphan(record.kind);
        continue;
      }
      const key = tupleKey([homeId, record.threadId, record.responseId]);
      if (!requestGroups.has(key))
        requestGroups.set(key, { threadId: record.threadId, responseId: record.responseId, records: [] });
      requestGroups.get(key).records.push(record);
      continue;
    }

    const eventKind = responseEventKind(record);
    if (eventKind) {
      if (
        typeof record.threadId === "string" &&
        record.threadId !== "" &&
        typeof record.turnId === "string" &&
        record.turnId !== ""
      ) {
        const responseId = responseIdAfter(record);
        if (responseId) {
          const eventKey =
            typeof record.itemId === "string" && record.itemId !== ""
              ? `item:${record.itemId}`
              : `anonymous:${record.sourcePath ?? ""}:${Number(record.lineNumber) || 0}`;
          const key = tupleKey([homeId, record.threadId, record.turnId, responseId, eventKey]);
          if (!responseEventGroups.has(key)) {
            responseEventGroups.set(key, {
              threadId: record.threadId,
              turnId: record.turnId,
              responseId,
              itemId: typeof record.itemId === "string" && record.itemId !== "" ? record.itemId : null,
              records: [],
            });
          }
          responseEventGroups.get(key).records.push(record);
        }
      }
      if (record.kind === "response_item") continue;
    }

    if (typeof record.kind !== "string" || !["turn_context", "item_completed", "task_complete"].includes(record.kind))
      continue;
    if (
      typeof record.threadId !== "string" ||
      record.threadId === "" ||
      typeof record.turnId !== "string" ||
      record.turnId === ""
    ) {
      orphan(record.kind);
      continue;
    }
    const turn = getTurn(record.threadId, record.turnId);
    if (record.kind === "turn_context") turn._contexts.push(record);
    if (record.kind === "task_complete") {
      turn.hasTaskComplete = true;
      turn._terminals.push(record);
    }
    if (record.kind === "item_completed") {
      if (typeof record.itemId !== "string" || record.itemId === "") {
        stats.unkeyableItemRecords += 1;
        turn.diagnostics.unkeyableItemCount += 1;
        continue;
      }
      const key = tupleKey([homeId, record.threadId, record.turnId, record.itemId]);
      if (!itemGroups.has(key)) itemGroups.set(key, { turn, itemId: record.itemId, records: [] });
      itemGroups.get(key).records.push(record);
    }
  }

  for (const group of requestGroups.values()) {
    const source = group.records[0];
    const turnIds = [
      ...new Set(group.records.map((record) => record.turnId).filter((id) => typeof id === "string" && id !== "")),
    ];
    const output = resolveField(group.records, "outputTokens");
    const reasoning = resolveField(group.records, "reasoningOutputTokens");
    const nativeGeneration = resolveField(group.records, "nativeGeneration");
    const cumulative = resolveField(group.records, "turnOutputTokens");
    const timestamp = resolveTimestamp(group.records);
    const responseConflict =
      output.conflict || reasoning.conflict || nativeGeneration.conflict || timestamp.conflict || turnIds.length > 1;
    const request = {
      responseId: group.responseId,
      outputTokens: output.value,
      reasoningOutputTokens: reasoning.value,
      reasoningOutputTokensKnown: reasoning.value !== null,
      turnOutputTokens: cumulative.value,
      timestampMs: timestamp.value,
      sourcePath: source.sourcePath ?? "",
      lineNumber: Number(source.lineNumber) || 0,
    };
    group.output = output;
    group.reasoning = reasoning;
    group.nativeGeneration = nativeGeneration;
    group.cumulative = cumulative;
    group.timestamp = timestamp;
    group.conflict = responseConflict;
    group.responseConflict = responseConflict;
    group.turnIds = turnIds;
    if (!responseOwners.has(group.responseId)) responseOwners.set(group.responseId, new Set());
    for (const turnId of turnIds) {
      responseOwners.get(group.responseId).add(tupleKey([group.threadId, turnId]));
    }
    if (turnIds.length !== 1) {
      stats.unassignedRequests += 1;
      if (turnIds.length > 1) {
        stats.conflictingRequests += 1;
        for (const id of turnIds) markConflict(getTurn(group.threadId, id), `request:${group.responseId}`);
      }
      continue;
    }
    const turn = getTurn(group.threadId, turnIds[0]);
    if (responseConflict) markConflict(turn, `request:${group.responseId}`);
    // A cumulative snapshot describes the whole turn, so it remains a turn
    // diagnostic without invalidating this response's independent v3 facts.
    if (cumulative.conflict) markConflict(turn, `request_cumulative:${group.responseId}`);
    turn.requests.push(request);
  }

  for (const [responseId, owners] of responseOwners) {
    if (owners.size <= 1) continue;
    for (const owner of owners) {
      const [threadId, turnId] = JSON.parse(owner);
      markConflict(getTurn(threadId, turnId), `response:${responseId}`);
    }
  }

  const responseEvents = new Map();
  for (const group of responseEventGroups.values()) {
    const kinds = [...new Set(group.records.map(responseEventKind).filter(Boolean))].sort(compareText);
    const responseItemRecords = group.records.filter((record) => record.kind === "response_item");
    const completedItemRecords = group.records.filter((record) => record.kind === "item_completed");
    const timestamp = resolveTimestamp(responseItemRecords);
    const started = resolveField(completedItemRecords, "startedAtMs");
    const completed = resolveField(completedItemRecords, "completedAtMs");
    const conflict = kinds.length !== 1 || timestamp.conflict || started.conflict || completed.conflict;
    if (conflict)
      markConflict(getTurn(group.threadId, group.turnId), `response_item:${group.responseId}:${group.itemId ?? ""}`);
    const key = tupleKey([homeId, group.threadId, group.turnId, group.responseId]);
    if (!responseEvents.has(key)) responseEvents.set(key, []);
    responseEvents.get(key).push({
      itemId: group.itemId,
      outputKind: kinds.length === 1 ? kinds[0] : null,
      timestampMs: timestamp.value,
      startedAtMs: started.value,
      completedAtMs: completed.value,
      conflict,
      _order: Math.min(...group.records.map((record) => record.inputOrder)),
    });
  }
  for (const events of responseEvents.values()) {
    events.sort((left, right) => left._order - right._order);
  }

  for (const group of requestGroups.values()) {
    if (group.turnIds.length === 0) continue;
    const key = tupleKey([homeId, group.threadId, group.turnIds[0], group.responseId]);
    const events = group.turnIds.length === 1 ? (responseEvents.get(key) ?? []) : [];
    const owners = responseOwners.get(group.responseId);
    const ownershipConflict = owners?.size > 1;
    for (const turnId of group.turnIds) {
      const turn = getTurn(group.threadId, turnId);
      if (ownershipConflict) markConflict(turn, `response:${group.responseId}`);
      turn.responses.push({
        responseId: group.responseId,
        outputTokens: group.output.value,
        reasoningOutputTokens: group.reasoning.value,
        reasoningOutputTokensKnown: group.reasoning.value !== null,
        ...(group.nativeGeneration.value === null ? {} : { nativeGeneration: group.nativeGeneration.value }),
        timestampMs: group.timestamp.value,
        sourcePath: group.records[0].sourcePath ?? "",
        lineNumber: Number(group.records[0].lineNumber) || 0,
        events: events.map(({ _order, ...event }) => event),
        conflict: Boolean(group.responseConflict || ownershipConflict || group.turnIds.length > 1),
      });
    }
  }

  for (const group of itemGroups.values()) {
    const { turn, itemId, records: itemRecords } = group;
    const type = resolveField(itemRecords, "itemType");
    const started = resolveField(itemRecords, "startedAtMs");
    const completed = resolveField(itemRecords, "completedAtMs");
    if (type.conflict || started.conflict || completed.conflict) markConflict(turn, `item:${itemId}`);
    turn.items.push({ itemId, itemType: type.value, startedAtMs: started.value, completedAtMs: completed.value });
  }

  const outputTurns = [];
  for (const turn of turns.values()) {
    const models = valuesOf(turn._contexts, "model").sort(compareText);
    const efforts = valuesOf(turn._contexts, "effort").sort(compareText);
    turn.modelValues = models;
    turn.effortValues = efforts;
    turn.model = models.length === 1 ? models[0] : null;
    turn.effort = efforts.length === 1 ? efforts[0] : null;
    turn.modelEvidence = turn.model === null ? null : "turn_context";
    if (models.length > 1 || efforts.length > 1) turn.flags.add("MODEL_AMBIGUOUS");

    if (turn._terminals.length > 0) {
      const started = resolveField(turn._terminals, "startedAtSec");
      const completed = resolveField(turn._terminals, "completedAtSec");
      const duration = resolveField(turn._terminals, "durationMs");
      if (started.conflict || completed.conflict || duration.conflict) markConflict(turn, "task_complete");
      turn.taskComplete = { startedAtSec: started.value, completedAtSec: completed.value, durationMs: duration.value };
    }

    turn.agentKind = threadIsSubagent.get(turn.threadId) === true ? "subagent" : "unknown";
    turn.requestSetComplete = turn.diagnostics.unkeyableRequestCount === 0;
    // Unkeyable rows cannot enter the request sum, but their cumulative snapshots
    // still determine which observation is last for the cross-check.
    const observations = [
      ...turn.requests.map((request) => ({ ...request, evidenceKind: "keyed_request" })),
      ...turn.diagnostics.unkeyableRequests.map((record) => ({ ...record, evidenceKind: "unkeyable_request" })),
    ];
    const sorted = sortRequests(observations);
    turn.requests = sorted.ordered
      .filter((request) => request.evidenceKind === "keyed_request")
      .map(({ evidenceKind, ...request }) => request);
    turn.responses = sortRequests(turn.responses).ordered;
    turn.requestOrderBasis = sorted.basis;
    turn.requestCount = turn.requests.length;
    turn.responseCount = turn.responses.length;
    turn.itemCount = turn.items.length;
    if (
      turn.requestCount > 0 &&
      turn.requests.every((request) => Number.isSafeInteger(request.outputTokens) && request.outputTokens >= 0)
    ) {
      const sum = turn.requests.reduce((total, request) => total + request.outputTokens, 0);
      if (Number.isSafeInteger(sum)) turn.requestOutputSum = sum;
    }
    const lastObservation = sorted.ordered.at(-1);
    turn.lastTurnOutputTokens = lastObservation?.turnOutputTokens ?? null;
    turn.lastTurnOutputSource = lastObservation?.evidenceKind ?? null;
    if (Number.isSafeInteger(turn.requestOutputSum) && Number.isSafeInteger(turn.lastTurnOutputTokens)) {
      if (turn.requestOutputSum !== turn.lastTurnOutputTokens) {
        turn.crossCheckState = "conflict";
        turn.requestSumMismatchCount = 1;
        stats.requestSumMismatchCount += 1;
        markConflict(turn, "request_sum_cross_check");
      } else if (!turn.requestSetComplete) {
        turn.crossCheckState = "unavailable";
      } else {
        turn.crossCheckState = "matched";
      }
    }
    turn.flags = [...turn.flags].sort(compareText);
    turn.recordConflictCount = turn.conflictKeys.size;
    stats.requestCount += turn.requestCount;
    stats.responseCount += turn.responseCount;
    stats.itemCount += turn.itemCount;
    stats.recordConflictCount += turn.recordConflictCount;
    delete turn.conflictKeys;
    delete turn._contexts;
    delete turn._terminals;
    outputTurns.push(turn);
  }
  outputTurns.sort((a, b) => compareText(a.threadId, b.threadId) || compareText(a.turnId, b.turnId));
  stats.turnCount = outputTurns.length;
  return {
    turns: outputTurns,
    stats: { ...stats, orphanByKind: Object.fromEntries([...orphanByKind].sort(([a], [b]) => compareText(a, b))) },
  };
}
