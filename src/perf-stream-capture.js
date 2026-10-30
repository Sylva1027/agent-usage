/**
 * Capture visible output from Responses, Anthropic Messages, and Chat
 * Completions SSE streams. The parser retains text only until finish().
 */

import { measureOutputWindows } from "./perf-output-tokens.js";

const ANTHROPIC_EVENT_TYPES = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
]);

const ANTHROPIC_SERVER_BLOCK_TYPES = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "mcp_tool_use",
  "mcp_tool_result",
  "bash_tool_use",
  "bash_tool_result",
  "text_editor_tool_use",
  "text_editor_tool_result",
  "container_upload",
]);

/** @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {value is number} */
function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function readIdKey(readId) {
  if (typeof readId === "string" && readId !== "") return `string:${readId}`;
  if (isNonNegativeSafeInteger(readId)) return `number:${readId}`;
  return null;
}

function responseItemId(payload, outputIndex) {
  if (typeof payload.item_id === "string" && payload.item_id !== "") return payload.item_id;
  if (isRecord(payload.item) && typeof payload.item.id === "string" && payload.item.id !== "") return payload.item.id;
  return `output:${String(outputIndex)}`;
}

function chatContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function responseServerToolMarker(type, payload) {
  const itemType =
    isRecord(payload.item) && typeof payload.item.type === "string"
      ? payload.item.type
      : isRecord(payload.response) && Array.isArray(payload.response.output)
        ? payload.response.output.find(
            (item) =>
              isRecord(item) &&
              (item.id === payload.item_id ||
                (isNonNegativeSafeInteger(payload.output_index) &&
                  payload.response.output.indexOf(item) === payload.output_index)),
          )?.type
        : null;
  if (
    typeof itemType === "string" &&
    (itemType.startsWith("mcp_") ||
      (itemType.endsWith("_call") && itemType !== "function_call" && itemType !== "custom_tool_call"))
  ) {
    return true;
  }

  const callType = type.match(/^response\.([a-z0-9_]+_call)\./)?.[1];
  return (
    (callType !== undefined && callType !== "function_call" && callType !== "custom_tool_call") ||
    type.startsWith("response.mcp_")
  );
}

function anthropicServerToolMarker(type, payload) {
  if (type !== "content_block_start" || !isRecord(payload.content_block)) return false;
  const blockType = payload.content_block.type;
  return (
    typeof blockType === "string" &&
    (ANTHROPIC_SERVER_BLOCK_TYPES.has(blockType) || (blockType !== "tool_use" && blockType.includes("_tool_")))
  );
}

function chatServerToolMarker(payload) {
  if (
    payload.server_tool_call !== undefined ||
    payload.server_tool_execution !== undefined ||
    payload.server_tool_use !== undefined
  ) {
    return true;
  }
  if (!Array.isArray(payload.choices)) return false;
  return payload.choices.some(
    (choice) =>
      isRecord(choice) &&
      isRecord(choice.delta) &&
      (choice.delta.server_tool_call !== undefined ||
        choice.delta.server_tool_execution !== undefined ||
        choice.delta.server_tool_use !== undefined),
  );
}

function responseReasoningMarker(type, payload) {
  if (type.includes("reasoning")) return true;
  return (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    isRecord(payload.item) &&
    payload.item.type === "reasoning"
  );
}

function anthropicReasoningDeltaMarker(delta) {
  return typeof delta.type === "string" && (delta.type.includes("thinking") || delta.type.includes("signature"));
}

function chatReasoningMarker(delta) {
  return (
    (Object.hasOwn(delta, "reasoning_content") &&
      delta.reasoning_content !== null &&
      delta.reasoning_content !== undefined) ||
    (Object.hasOwn(delta, "reasoning") && delta.reasoning !== null && delta.reasoning !== undefined)
  );
}

/**
 * @typedef {object} PushStamp
 * @property {number} elapsedMs
 * @property {string | number} readId
 */

/**
 * @typedef {object} CaptureWindow
 * @property {number} phase
 * @property {number | null} startU16
 * @property {number} endU16
 * @property {string | number} firstReadId
 * @property {PushStamp} firstStamp
 * @property {PushStamp} lastStamp
 */

/**
 * @typedef {object} CaptureLane
 * @property {string} text
 * @property {CaptureWindow[]} windows
 */

/**
 * @returns {{
 *   push: (bytes: Uint8Array, stamp: {elapsedMs: number, readId: string | number}) => void,
 *   finish: () => ({responseId: string, model: string, measurement: import("./perf-output-tokens.js").MeasuredOutput | null} | null)
 * }}
 */
export function createOutputStreamCapture() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  /** @type {Map<string, PushStamp>} */
  const stampsByReadId = new Map();
  /** @type {Map<string, CaptureLane>} */
  const lanes = new Map();
  /** @type {Map<number, string>} */
  const anthropicBlockTypes = new Map();

  let decodedText = "";
  let eventName = "";
  /** @type {string[]} */
  let dataLines = [];
  let protocol = null;
  let responseId = "";
  let model = "";
  let phase = 0;
  let successfulTerminal = false;
  let failed = false;
  let finished = false;
  let finishedResult = null;

  function fail() {
    failed = true;
  }

  function setProtocol(nextProtocol) {
    if (protocol !== null && protocol !== nextProtocol) {
      fail();
      return false;
    }
    protocol = nextProtocol;
    return true;
  }

  function setIdentity(nextResponseId, nextModel) {
    if (nextResponseId !== null) {
      if (responseId !== "" && responseId !== nextResponseId) {
        fail();
        return;
      }
      responseId = nextResponseId;
    }
    if (nextModel !== null) {
      if (model !== "" && model !== nextModel) {
        fail();
        return;
      }
      model = nextModel;
    }
  }

  function interruptPhase() {
    if (phase === Number.MAX_SAFE_INTEGER) {
      fail();
      return;
    }
    phase += 1;
  }

  function laneKey(kind, parts) {
    return JSON.stringify([kind, ...parts]);
  }

  function addVisibleText(kind, parts, text, stamp) {
    if (failed || text === "") return;
    const key = laneKey(kind, parts);
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = {
        text: "",
        windows: [],
      };
      lanes.set(key, lane);
    }
    let window = lane.windows.at(-1);
    if (window === undefined || window.phase !== phase) {
      window = {
        phase,
        startU16: null,
        endU16: lane.text.length,
        firstReadId: stamp.readId,
        firstStamp: stamp,
        lastStamp: stamp,
      };
      lane.windows.push(window);
    } else if (window.startU16 === null && !Object.is(window.firstReadId, stamp.readId)) {
      window.startU16 = lane.text.length;
    }
    lane.text += text;
    window.endU16 = lane.text.length;
    window.lastStamp = stamp;
  }

  function stampFor(meta) {
    if (!isRecord(meta) || typeof meta.elapsedMs !== "number" || !Number.isFinite(meta.elapsedMs)) {
      fail();
      return null;
    }
    const elapsedMs = Math.round(meta.elapsedMs);
    const readId = meta.readId;
    const key = readIdKey(readId);
    if (!isNonNegativeSafeInteger(elapsedMs) || key === null) {
      fail();
      return null;
    }
    let stamp = stampsByReadId.get(key);
    if (stamp === undefined) {
      stamp = { elapsedMs, readId: /** @type {string | number} */ (readId) };
      stampsByReadId.set(key, stamp);
    }
    return stamp;
  }

  function detectProtocol(type, payload) {
    if (type.startsWith("response.") || payload.object === "response") return "responses";
    if (ANTHROPIC_EVENT_TYPES.has(type) || type.startsWith("content_block.")) return "anthropic";
    if (payload.object === "chat.completion.chunk" || Array.isArray(payload.choices)) return "chat";
    return null;
  }

  function handleResponses(type, payload, stamp) {
    if (isRecord(payload.response)) {
      setIdentity(nonEmptyString(payload.response.id), nonEmptyString(payload.response.model));
    }
    if (type === "response.completed") {
      successfulTerminal = true;
      return;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      fail();
      return;
    }
    if (responseServerToolMarker(type, payload)) {
      interruptPhase();
      return;
    }
    if (responseReasoningMarker(type, payload)) {
      interruptPhase();
      return;
    }

    const outputIndex = payload.output_index;
    const contentIndex = payload.content_index ?? 0;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (typeof payload.delta !== "string" || payload.delta === "") return;
      const kind = type === "response.refusal.delta" ? "refusal" : "text";
      addVisibleText(kind, [responseItemId(payload, outputIndex), outputIndex, contentIndex], payload.delta, stamp);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      if (typeof payload.delta !== "string" || payload.delta === "") return;
      addVisibleText("function-arguments", [responseItemId(payload, outputIndex), outputIndex], payload.delta, stamp);
      return;
    }
    if (type === "response.custom_tool_call_input.delta") {
      if (typeof payload.delta !== "string" || payload.delta === "") return;
      addVisibleText("custom-input", [responseItemId(payload, outputIndex), outputIndex], payload.delta, stamp);
    }
  }

  function handleAnthropic(type, payload, stamp) {
    if (type === "message_start" && isRecord(payload.message)) {
      setIdentity(nonEmptyString(payload.message.id), nonEmptyString(payload.message.model));
      return;
    }
    if (type === "message_stop") {
      successfulTerminal = true;
      return;
    }
    if (type === "content_block_start") {
      if (!isNonNegativeSafeInteger(payload.index) || !isRecord(payload.content_block)) return;
      const blockType = payload.content_block.type;
      if (typeof blockType === "string") anthropicBlockTypes.set(payload.index, blockType);
      if (anthropicServerToolMarker(type, payload) || blockType === "thinking" || blockType === "redacted_thinking") {
        interruptPhase();
      }
      return;
    }
    if (type !== "content_block_delta" || !isNonNegativeSafeInteger(payload.index) || !isRecord(payload.delta)) {
      return;
    }

    const blockType = anthropicBlockTypes.get(payload.index);
    if (anthropicReasoningDeltaMarker(payload.delta)) {
      interruptPhase();
      return;
    }
    if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
      addVisibleText("text", [payload.index], payload.delta.text, stamp);
      return;
    }
    if (payload.delta.type === "input_json_delta" && typeof payload.delta.partial_json === "string") {
      if (blockType !== undefined && ANTHROPIC_SERVER_BLOCK_TYPES.has(blockType)) return;
      addVisibleText("tool-input", [payload.index], payload.delta.partial_json, stamp);
      return;
    }
  }

  function handleChat(payload, stamp) {
    setIdentity(nonEmptyString(payload.id), nonEmptyString(payload.model));
    if (payload.error !== undefined && payload.error !== null) {
      fail();
      return;
    }
    if (chatServerToolMarker(payload)) interruptPhase();
    if (!Array.isArray(payload.choices)) return;

    for (const choice of payload.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue;
      const choiceIndex = choice.index;
      if (!isNonNegativeSafeInteger(choiceIndex)) continue;

      if (chatReasoningMarker(choice.delta)) interruptPhase();
      const content = chatContentText(choice.delta.content);
      if (content !== "") addVisibleText("content", [choiceIndex], content, stamp);

      if (!Array.isArray(choice.delta.tool_calls)) continue;
      for (let arrayIndex = 0; arrayIndex < choice.delta.tool_calls.length; arrayIndex += 1) {
        const toolCall = choice.delta.tool_calls[arrayIndex];
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
        const toolIndex = isNonNegativeSafeInteger(toolCall.index) ? toolCall.index : arrayIndex;
        if (typeof toolCall.function.arguments !== "string" || toolCall.function.arguments === "") continue;
        addVisibleText("tool-arguments", [choiceIndex, toolIndex], toolCall.function.arguments, stamp);
      }
    }
  }

  function dispatchEvent(stamp) {
    const data = dataLines.join("\n");
    const dispatchedEventName = eventName;
    dataLines = [];
    eventName = "";
    if (data === "") return;
    if (data.trim() === "[DONE]") {
      if (protocol !== "chat") fail();
      else successfulTerminal = true;
      return;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      fail();
      return;
    }
    if (!isRecord(payload)) {
      fail();
      return;
    }

    const type = typeof payload.type === "string" && payload.type !== "" ? payload.type : dispatchedEventName;
    const detectedProtocol = detectProtocol(type, payload);
    if (detectedProtocol !== null && !setProtocol(detectedProtocol)) return;
    if (failed) return;
    if (type === "error" || (payload.error !== undefined && payload.error !== null)) {
      fail();
      return;
    }
    if (protocol === "responses") handleResponses(type, payload, stamp);
    else if (protocol === "anthropic") handleAnthropic(type, payload, stamp);
    else if (protocol === "chat") handleChat(payload, stamp);
  }

  function handleLine(line, stamp) {
    if (line === "") {
      dispatchEvent(stamp);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  function parseLines(stamp) {
    while (decodedText !== "") {
      let lineEnd = -1;
      let separatorLength = 1;
      for (let index = 0; index < decodedText.length; index += 1) {
        const character = decodedText[index];
        if (character === "\r") {
          if (index + 1 === decodedText.length) return;
          lineEnd = index;
          separatorLength = decodedText[index + 1] === "\n" ? 2 : 1;
          break;
        }
        if (character === "\n") {
          lineEnd = index;
          break;
        }
      }
      if (lineEnd === -1) return;
      const line = decodedText.slice(0, lineEnd);
      decodedText = decodedText.slice(lineEnd + separatorLength);
      handleLine(line, stamp);
    }
  }

  function push(bytes, meta) {
    if (finished || failed) return;
    if (!(bytes instanceof Uint8Array)) {
      fail();
      return;
    }
    const stamp = stampFor(meta);
    if (stamp === null) return;
    try {
      decodedText += decoder.decode(bytes, { stream: true });
    } catch {
      fail();
      return;
    }
    parseLines(stamp);
  }

  function measuredLanes() {
    function utf8OffsetAtU16(text, offset) {
      let boundary = offset;
      if (
        boundary > 0 &&
        boundary < text.length &&
        text.charCodeAt(boundary - 1) >= 0xd800 &&
        text.charCodeAt(boundary - 1) <= 0xdbff &&
        text.charCodeAt(boundary) >= 0xdc00 &&
        text.charCodeAt(boundary) <= 0xdfff
      ) {
        boundary -= 1;
      }
      return Buffer.byteLength(text.slice(0, boundary));
    }

    const result = [];
    for (const lane of lanes.values()) {
      if (lane.text === "") continue;
      result.push({
        text: lane.text,
        windows: lane.windows.map((window) => ({
          startBytes: utf8OffsetAtU16(lane.text, window.startU16 ?? window.endU16),
          endBytes: utf8OffsetAtU16(lane.text, window.endU16),
          startMs: window.firstStamp.elapsedMs,
          endMs: window.lastStamp.elapsedMs,
        })),
      });
    }
    return result;
  }

  function finish() {
    if (finished) return finishedResult;
    if (failed || !successfulTerminal || responseId === "" || model === "") {
      return null;
    }

    finished = true;
    let measurement = null;
    try {
      measurement = measureOutputWindows(measuredLanes());
    } catch {
      measurement = null;
    }
    finishedResult = { responseId, model, measurement };
    lanes.clear();
    return finishedResult;
  }

  return { push, finish };
}
