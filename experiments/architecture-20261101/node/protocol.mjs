const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

export const USAGE_FIELDS = ["input", "cached", "output", "reasoning", "total"];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSourceId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError("sourceId must be a non-empty string");
  }
  return value;
}

export function validateTimestamp(value, label = "timestamp") {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new InputError(`${label} must be a valid ISO timestamp`);
  }
  return value;
}

export function validateEvents(events, sourceId) {
  if (!Array.isArray(events)) {
    throw new InputError("events must be an array");
  }

  const ids = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const prefix = `events[${index}]`;
    if (!isRecord(event)) {
      throw new InputError(`${prefix} must be an object`);
    }
    for (const field of ["eventId", "sessionId", "homeId"]) {
      if (typeof event[field] !== "string" || event[field].trim() === "") {
        throw new InputError(`${prefix}.${field} must be a non-empty string`);
      }
    }
    validateTimestamp(event.timestamp, `${prefix}.timestamp`);
    if (!isRecord(event.total)) {
      throw new InputError(`${prefix}.total must be an object`);
    }
    for (const field of USAGE_FIELDS) {
      const value = event.total[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new InputError(`${prefix}.total.${field} must be a non-negative safe integer`);
      }
    }
    if (ids.has(event.eventId)) {
      throw new InputError(`duplicate eventId in source ${sourceId}: ${event.eventId}`);
    }
    ids.add(event.eventId);
  }
  return events;
}

export function validateCommitBody(body) {
  if (!isRecord(body)) {
    throw new InputError("request body must be an object");
  }
  const sourceId = validateSourceId(body.sourceId);
  validateEvents(body.events, sourceId);
  if (!Object.hasOwn(body, "cursor")) {
    throw new InputError("cursor is required");
  }
  if (Object.hasOwn(body, "context") && body.context !== null && !isRecord(body.context)) {
    throw new InputError("context must be an object or null");
  }
  return body;
}
