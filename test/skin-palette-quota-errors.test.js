import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import capture, {
  classifyExpectedQuotaErrors,
  buildStateBlockers,
  createQuotaEvidenceRecorder,
} from "../scripts/skin-palette/capture.mjs";

const text = "Failed to load resource: the server responded with a status of 409 (Conflict)";
function sample(snapshot = false) {
  const url = `http://127.0.0.1:12581/api/usage?preset=quota_5h&bucket=quota_30m&view=dashboard${snapshot ? "&snapshot=opaque-123" : ""}`;
  return {
    errors: {
      pageErrors: [],
      consoleErrors: [text],
      requestFailed: [],
      resourceFailures: [{ url, status: 409 }],
      blockedExternal: [],
    },
    scope: {
      id: "quota-1",
      pageId: 1,
      mode: "light",
      attempt: 1,
      unitId: "quota-toast",
      stateId: "quota-toast",
      origin: "http://127.0.0.1:12581",
      triggerSucceeded: true,
      startOrder: 10,
      endOrder: 30,
    },
    responses: [
      {
        requestId: "q1",
        scopeId: "quota-1",
        pageId: 1,
        method: "GET",
        url,
        requestOrder: 12,
        responseOrder: 14,
        status: 409,
        bodyReadStatus: "parsed",
        bodyCode: "QUOTA_WINDOW_UNAVAILABLE",
        resourceFailureIndex: 0,
      },
    ],
    consoles: [{ scopeId: "quota-1", pageId: 1, index: 0, order: 16, text, locationUrl: url }],
  };
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function refusal(input) {
  const before = JSON.stringify(input);
  const result = classifyExpectedQuotaErrors(frozen(input));
  assert.equal(JSON.stringify(input), before);
  assert.ok(result.rejected.length > 0);
  assert.ok(buildStateBlockers(result.scopedErrors).length > 0, "剩余原错误必须经真实 blocker 继续阻断");
  return result;
}

test("C8-C1：精确原响应及snapshot组合；输入深冻、原错误对象与元数据保留", () => {
  for (const snapshot of [false, true]) {
    const input = sample(snapshot);
    if (snapshot) {
      input.scope.mode = "dark";
      input.scope.attempt = 2;
    }
    input.errors.metadata = { untouched: true };
    const before = structuredClone(input);
    frozen(input);
    const result = classifyExpectedQuotaErrors(input);
    assert.deepEqual(input, before);
    assert.deepEqual(Object.keys(result).sort(), ["expectedErrors", "matches", "rejected", "scopedErrors"]);
    assert.deepEqual(buildStateBlockers(result.scopedErrors), []);
    assert.equal(result.rejected.length, 0);
    assert.strictEqual(result.expectedErrors.resourceFailures[0], input.errors.resourceFailures[0]);
    assert.strictEqual(result.expectedErrors.consoleErrors[0], input.errors.consoleErrors[0]);
    assert.strictEqual(result.scopedErrors.metadata, input.errors.metadata);
    assert.deepEqual(
      result.matches.map((m) => m.requestId),
      ["q1", "q1"],
    );
    assert.equal(result.matches[0].resourceFailureIndex, 0);
    assert.equal(result.matches[1].consoleErrorIndex, 0);
    assert.equal(result.matches[1].binding, "INFERRED_UNIQUE");
    assert.match(result.matches[1].basis, /非原生/);
  }
  assert.equal(Object.hasOwn(capture, "classifyExpectedQuotaErrors"), false, "默认导出未扩展、生产未接线");
});

test("C8-C1：只移除精确索引，所有其它原错误仍阻断；无console不补造", () => {
  const input = sample();
  input.errors.resourceFailures.unshift({ url: "http://127.0.0.1:12581/app.js", status: 500 });
  input.errors.consoleErrors.unshift("unexpected product error");
  input.responses[0].resourceFailureIndex = 1;
  input.consoles[0].index = 1;
  input.errors.pageErrors.push("uncaught exception");
  input.errors.requestFailed.push({ url: "other", error: "ERR_FAILED" });
  input.errors.blockedExternal.push("https://external.invalid/");
  const result = classifyExpectedQuotaErrors(frozen(input));
  for (const key of ["pageErrors", "requestFailed", "blockedExternal"])
    assert.deepEqual(result.scopedErrors[key], input.errors[key]);
  assert.deepEqual(result.scopedErrors.consoleErrors, ["unexpected product error"]);
  assert.deepEqual(result.scopedErrors.resourceFailures, [input.errors.resourceFailures[0]]);
  assert.equal(buildStateBlockers(result.scopedErrors).length, 4);
  const noConsole = sample();
  noConsole.errors.consoleErrors = [];
  noConsole.consoles = [];
  const output = classifyExpectedQuotaErrors(frozen(noConsole));
  assert.deepEqual(output.expectedErrors.consoleErrors, []);
  assert.equal(output.matches.length, 1);
  assert.deepEqual(buildStateBlockers(output.scopedErrors), []);
});

test("C8-C1：scope失败、畸形或非quota状态始终保留全部原错误", async (t) => {
  const cases = {
    missing: (x) => {
      x.scope = null;
    },
    state: (x) => {
      x.scope.stateId = "dashboard-default";
    },
    unit: (x) => {
      x.scope.unitId = "autorefresh-error";
    },
    page: (x) => {
      x.scope.pageId = "";
    },
    id: (x) => {
      x.scope.id = " ";
    },
    mode: (x) => {
      x.scope.mode = "system";
    },
    attempt: (x) => {
      x.scope.attempt = 0;
    },
    fractionalAttempt: (x) => {
      x.scope.attempt = 1.5;
    },
    failedTrigger: (x) => {
      x.scope.triggerSucceeded = false;
    },
    missingTrigger: (x) => {
      delete x.scope.triggerSucceeded;
    },
    reversedWindow: (x) => {
      x.scope.endOrder = 10;
    },
    nanWindow: (x) => {
      x.scope.startOrder = NaN;
    },
    fractionalOrder: (x) => {
      x.scope.startOrder = 10.5;
    },
    origin: (x) => {
      x.scope.origin = "invalid";
    },
    originPath: (x) => {
      x.scope.origin += "/nested";
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, () => {
      const x = sample();
      mutate(x);
      const r = refusal(x);
      assert.deepEqual(r.scopedErrors, x.errors);
    });
});

test("C8-C1：响应身份、业务码、精确URL、索引和窗口拒绝边界", async (t) => {
  const cases = {
    absent: (x) => {
      x.responses = [];
    },
    malformed: (x) => {
      x.responses = [null];
    },
    scope: (x) => {
      x.responses[0].scopeId = "other";
    },
    page: (x) => {
      x.responses[0].pageId = 2;
    },
    missingId: (x) => {
      delete x.responses[0].requestId;
    },
    emptyId: (x) => {
      x.responses[0].requestId = " ";
    },
    method: (x) => {
      x.responses[0].method = "POST";
    },
    urlObject: (x) => {
      x.responses[0].url = new URL(x.responses[0].url);
    },
    whitespaceUrl: (x) => {
      x.responses[0].url = ` ${x.responses[0].url}`;
    },
    relativeUrl: (x) => {
      x.responses[0].url = "/api/usage?preset=quota_5h&bucket=quota_30m";
    },
    origin: (x) => {
      x.responses[0].url = x.responses[0].url.replace(":12581", ":12582");
    },
    path: (x) => {
      x.responses[0].url = x.responses[0].url.replace("/api/usage?", "/api/usage-other?");
    },
    preset: (x) => {
      x.responses[0].url = x.responses[0].url.replace("quota_5h", "quota_week");
    },
    bucket: (x) => {
      x.responses[0].url = x.responses[0].url.replace("quota_30m", "quota_24h");
    },
    duplicatePreset: (x) => {
      x.responses[0].url += "&preset=quota_5h";
    },
    duplicateBucket: (x) => {
      x.responses[0].url += "&bucket=quota_30m";
    },
    missingBucket: (x) => {
      x.responses[0].url = x.responses[0].url.replace("&bucket=quota_30m", "");
    },
    credentials: (x) => {
      x.responses[0].url = x.responses[0].url.replace("http://", "http://user:password@");
    },
    fragment: (x) => {
      x.responses[0].url += "#fragment";
    },
    status413: (x) => {
      x.responses[0].status = 413;
    },
    otherCode: (x) => {
      x.responses[0].bodyCode = "OTHER_ERROR";
    },
    missingCode: (x) => {
      delete x.responses[0].bodyCode;
    },
    unread: (x) => {
      x.responses[0].bodyReadStatus = "pending";
    },
    parseFailed: (x) => {
      x.responses[0].bodyReadStatus = "failed";
    },
    requestAtStart: (x) => {
      x.responses[0].requestOrder = 10;
    },
    requestBefore: (x) => {
      x.responses[0].requestOrder = 9;
    },
    responseAtEnd: (x) => {
      x.responses[0].responseOrder = 30;
    },
    responseBeforeRequest: (x) => {
      x.responses[0].responseOrder = 11;
    },
    equalOrder: (x) => {
      x.responses[0].responseOrder = 12;
    },
    nanOrder: (x) => {
      x.responses[0].responseOrder = NaN;
    },
    index: (x) => {
      x.responses[0].resourceFailureIndex = 1;
    },
    negativeIndex: (x) => {
      x.responses[0].resourceFailureIndex = -1;
    },
    originalUrl: (x) => {
      x.errors.resourceFailures[0].url += "&snapshot=different";
    },
    originalStatus: (x) => {
      x.errors.resourceFailures[0].status = 413;
    },
    duplicateId: (x) => {
      x.responses.push({ ...x.responses[0], url: `${x.responses[0].url}&snapshot=other`, resourceFailureIndex: 1 });
    },
    duplicateUrl: (x) => {
      x.responses.push({ ...x.responses[0], requestId: "q2", resourceFailureIndex: 1, bodyReadStatus: "failed" });
    },
    duplicateIndex: (x) => {
      x.responses.push({ ...x.responses[0], requestId: "q2", url: `${x.responses[0].url}&snapshot=other` });
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, () => {
      const x = sample();
      mutate(x);
      if (
        [
          "urlObject",
          "whitespaceUrl",
          "relativeUrl",
          "origin",
          "path",
          "preset",
          "bucket",
          "duplicatePreset",
          "duplicateBucket",
          "missingBucket",
          "credentials",
          "fragment",
        ].includes(name)
      ) {
        x.errors.resourceFailures[0].url = x.responses[0].url;
        x.consoles[0].locationUrl = x.responses[0].url;
      }
      if (name === "status413") x.errors.resourceFailures[0].status = 413;
      const r = refusal(x);
      assert.deepEqual(r.expectedErrors.resourceFailures, []);
      assert.deepEqual(r.expectedErrors.consoleErrors, []);
    });
});

test("C8-C1：console缺来源、索引文本、页面窗口或候选不唯一仍阻断", async (t) => {
  const cases = {
    absent: (x) => {
      x.consoles = [];
    },
    malformed: (x) => {
      x.consoles = [null];
    },
    scope: (x) => {
      x.consoles[0].scopeId = "other";
    },
    page: (x) => {
      x.consoles[0].pageId = 2;
    },
    noLocation: (x) => {
      delete x.consoles[0].locationUrl;
    },
    emptyLocation: (x) => {
      x.consoles[0].locationUrl = "";
    },
    differentUrl: (x) => {
      x.consoles[0].locationUrl += "&snapshot=other";
    },
    index: (x) => {
      x.consoles[0].index = 1;
    },
    negative: (x) => {
      x.consoles[0].index = -1;
    },
    otherText: (x) => {
      x.consoles[0].text = "Failed to load resource: net::ERR_FAILED";
    },
    prefixOnly: (x) => {
      x.consoles[0].text = `${text} extra`;
      x.errors.consoleErrors[0] = `${text} extra`;
    },
    originalText: (x) => {
      x.errors.consoleErrors[0] = "other original error";
    },
    beforeResponse: (x) => {
      x.consoles[0].order = 13;
    },
    equalResponse: (x) => {
      x.consoles[0].order = 14;
    },
    end: (x) => {
      x.consoles[0].order = 30;
    },
    outside: (x) => {
      x.consoles[0].order = 31;
    },
    missingOrder: (x) => {
      delete x.consoles[0].order;
    },
    duplicateIndex: (x) => {
      x.consoles.push({ ...x.consoles[0] });
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, () => {
      const x = sample();
      mutate(x);
      const r = refusal(x);
      assert.deepEqual(r.expectedErrors.consoleErrors, []);
      assert.deepEqual(r.scopedErrors.consoleErrors, x.errors.consoleErrors);
    });
});

test("C8-C1：接口数组误用抛TypeError而不是将原错误变空", () => {
  for (const key of ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"]) {
    const x = sample();
    delete x.errors[key];
    assert.throws(() => classifyExpectedQuotaErrors(x), TypeError);
  }
  for (const key of ["responses", "consoles"]) {
    const x = sample();
    x[key] = null;
    assert.throws(() => classifyExpectedQuotaErrors(x), TypeError);
  }
});

// Tiny native method substitutes; no browser, DOM, or network.
const quotaUrl = "http://127.0.0.1:12581/api/usage?preset=quota_5h&bucket=quota_30m&snapshot=opaque";
function deferredBody() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function recorderSample() {
  const page = {};
  const errors = {
    pageErrors: [],
    consoleErrors: ["earlier"],
    requestFailed: [],
    resourceFailures: [{ url: "earlier", status: 500 }],
    blockedExternal: [],
  };
  const recorder = createQuotaEvidenceRecorder({ page, errors, origin: "http://127.0.0.1:12581" });
  const begin = (attempt = 1) =>
    recorder.begin({ mode: "light", attempt, unitId: "quota-toast", stateId: "quota-toast" });
  const request = ({ url = quotaUrl, nativePage = page, frameThrows = false } = {}) => ({
    url: () => url,
    method: () => "GET",
    frame: () => {
      if (frameThrows) throw new Error("detached frame");
      return { page: () => nativePage };
    },
  });
  const response = (
    req,
    {
      status = 409,
      body = () => Promise.resolve(Buffer.from('{"code":"QUOTA_WINDOW_UNAVAILABLE","quota":{"state":"missing"}}')),
    } = {},
  ) => ({ request: () => req, url: () => req.url(), status: () => status, body });
  const resource = (res) => {
    errors.resourceFailures.push({ url: res.url(), status: res.status() });
    recorder.onResponse(res, errors.resourceFailures.length - 1);
  };
  const consoleMessage = (url = quotaUrl) => {
    errors.consoleErrors.push(text);
    recorder.onConsole(
      { text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }) },
      errors.consoleErrors.length - 1,
    );
  };
  const delta = () => ({
    ...errors,
    resourceFailures: errors.resourceFailures.slice(1),
    consoleErrors: errors.consoleErrors.slice(1),
  });
  return { page, errors, recorder, begin, request, response, resource, consoleMessage, delta };
}

test("C8-C2a：原生对象/完整URL/原body、相对index与严格顺序可送C1，输入不变", async () => {
  const x = recorderSample();
  x.begin();
  const req = x.request();
  x.recorder.onRequest(req);
  x.recorder.markTriggerResult(true);
  let reads = 0;
  const body = '{"code":"QUOTA_WINDOW_UNAVAILABLE","quota":{"state":"missing"}}';
  const res = x.response(req, {
    body: async () => {
      reads++;
      return Buffer.from(body);
    },
  });
  x.resource(res);
  x.recorder.onResponse(res, 1);
  x.consoleMessage();
  x.recorder.endWindow();
  const originalErrors = structuredClone(x.errors);
  const snapshot = await x.recorder.settleAndSnapshot();
  assert.deepEqual(x.errors, originalErrors);
  assert.equal(reads, 1);
  assert.equal(snapshot.responses[0].url, quotaUrl);
  assert.equal(snapshot.responses[0].resourceFailureIndex, 0);
  assert.equal(snapshot.consoles[0].index, 0);
  assert.equal(snapshot.responses[0].bodyText, body);
  assert.equal(snapshot.responses[0].bodyBytes, Buffer.byteLength(body));
  assert.equal(snapshot.responses[0].bodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(snapshot.responses[0].bodyCode, "QUOTA_WINDOW_UNAVAILABLE");
  assert.ok(snapshot.scope.startOrder < snapshot.responses[0].requestOrder);
  assert.ok(snapshot.responses[0].requestOrder < snapshot.responses[0].responseOrder);
  assert.ok(snapshot.responses[0].responseOrder < snapshot.consoles[0].order);
  assert.ok(snapshot.consoles[0].order < snapshot.scope.endOrder);
  const result = classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot });
  assert.deepEqual(buildStateBlockers(result.scopedErrors), []);
  assert.equal(result.matches.at(-1).binding, "INFERRED_UNIQUE");
  snapshot.responses[0].bodyCode = "caller mutation";
  assert.equal((await x.recorder.settleAndSnapshot()).responses[0].bodyCode, "QUOTA_WINDOW_UNAVAILABLE");
});

test("C8-C2a：同URL的其它状态及未完成请求都保留，不能制造唯一", async (t) => {
  for (const secondStatus of [200, null])
    await t.test(String(secondStatus), async () => {
      const x = recorderSample();
      x.begin();
      x.recorder.markTriggerResult(true);
      const first = x.request(),
        second = x.request();
      x.recorder.onRequest(first);
      x.recorder.onRequest(second);
      x.resource(x.response(first));
      if (secondStatus !== null)
        x.recorder.onResponse(
          x.response(second, {
            status: secondStatus,
            body: () => {
              throw new Error("200 body must not be read");
            },
          }),
          undefined,
        );
      x.consoleMessage();
      x.recorder.endWindow();
      const snapshot = await x.recorder.settleAndSnapshot();
      assert.equal(snapshot.responses.length, 2);
      assert.notEqual(snapshot.responses[0].requestId, snapshot.responses[1].requestId);
      assert.equal(snapshot.consoles[0].scopeId, null);
      const result = classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot });
      assert.equal(result.expectedErrors.resourceFailures.length, 0);
      assert.ok(buildStateBlockers(result.scopedErrors).length > 0);
    });
});

test("C8-C2a：不同page、未知frame和未见原request的response不伪造身份", async (t) => {
  for (const kind of ["other-page", "frame-unavailable", "unbound"])
    await t.test(kind, async () => {
      const x = recorderSample();
      x.begin();
      x.recorder.markTriggerResult(true);
      const req = x.request({
        nativePage: kind === "other-page" ? {} : x.page,
        frameThrows: kind === "frame-unavailable",
      });
      if (kind !== "unbound") x.recorder.onRequest(req);
      let reads = 0;
      x.resource(
        x.response(req, {
          body: async () => {
            reads++;
            return Buffer.from('{"code":"QUOTA_WINDOW_UNAVAILABLE"}');
          },
        }),
      );
      x.consoleMessage();
      x.recorder.endWindow();
      const snapshot = await x.recorder.settleAndSnapshot();
      assert.equal(reads, 0);
      assert.equal(snapshot.responses[0].scopeId, null);
      assert.equal(snapshot.responses[0].pageId, null);
      assert.ok(
        buildStateBlockers(classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot }).scopedErrors).length > 0,
      );
    });
});

test("C8-C2a：关闭读取失败、坏JSON、非对象、缺code保留原文与明确状态", async (t) => {
  const cases = [
    ["closed", null, "read-failed"],
    ["bad-json", "{broken", "invalid-json"],
    ["primitive", '"ok"', "invalid-body"],
    ["array", "[]", "invalid-body"],
    ["missing-code", "{}", "invalid-body"],
  ];
  for (const [name, raw, status] of cases)
    await t.test(name, async () => {
      const x = recorderSample();
      x.begin();
      x.recorder.markTriggerResult(true);
      const req = x.request();
      x.recorder.onRequest(req);
      x.resource(
        x.response(req, {
          body: async () => {
            if (raw === null) throw new Error("Target page/context closed");
            return Buffer.from(raw);
          },
        }),
      );
      x.consoleMessage();
      x.recorder.endWindow();
      const snapshot = await x.recorder.settleAndSnapshot();
      assert.equal(snapshot.responses[0].bodyReadStatus, status);
      assert.equal(snapshot.responses[0].bodyCode, null);
      assert.ok(snapshot.responses[0].bodyError);
      if (raw !== null) assert.equal(snapshot.responses[0].bodyText, raw);
      assert.ok(
        buildStateBlockers(classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot }).scopedErrors).length > 0,
      );
    });
});

test("C8-C2a：1000ms超时有界且晚完成不改快照，晚拒绝无unhandled rejection", async () => {
  const x = recorderSample();
  x.begin();
  x.recorder.markTriggerResult(true);
  const req = x.request();
  x.recorder.onRequest(req);
  const body = deferredBody();
  x.resource(x.response(req, { body: () => body.promise }));
  x.consoleMessage();
  x.recorder.endWindow();
  const snapshot = await x.recorder.settleAndSnapshot();
  assert.equal(snapshot.responses[0].bodyReadStatus, "timeout");
  assert.equal(snapshot.responses[0].bodyCode, null);
  const before = structuredClone(snapshot);
  body.resolve(Buffer.from('{"code":"QUOTA_WINDOW_UNAVAILABLE"}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshot, before);
  assert.deepEqual(await x.recorder.settleAndSnapshot(), before);
  assert.ok(
    buildStateBlockers(classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot }).scopedErrors).length > 0,
  );
  const y = recorderSample();
  y.begin();
  y.recorder.markTriggerResult(true);
  const other = y.request();
  y.recorder.onRequest(other);
  const rejected = deferredBody();
  y.resource(y.response(other, { body: () => rejected.promise }));
  y.recorder.endWindow();
  const lateSnapshot = await y.recorder.settleAndSnapshot();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    rejected.reject(new Error("late context closed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(lateSnapshot.responses[0].bodyReadStatus, "timeout");
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("C8-C2a：晚响应保留旧scope及窗口外顺序，连续窗口console不串线", async () => {
  const x = recorderSample();
  x.begin();
  x.recorder.markTriggerResult(true);
  const first = x.request();
  x.recorder.onRequest(first);
  x.recorder.endWindow();
  const old = await x.recorder.settleAndSnapshot();
  assert.equal(old.responses[0].bodyReadStatus, "not-received");
  x.begin(2);
  x.recorder.markTriggerResult(true);
  const second = x.request();
  x.recorder.onRequest(second);
  x.resource(x.response(first));
  x.resource(x.response(second));
  x.consoleMessage();
  x.recorder.endWindow();
  const next = await x.recorder.settleAndSnapshot();
  assert.notEqual(next.scope.id, old.scope.id);
  assert.equal(next.scope.attempt, 2);
  assert.equal(next.responses.length, 1);
  assert.equal(next.responses[0].scopeId, next.scope.id);
  assert.equal(next.consoles[0].scopeId, null);
  assert.match(next.consoles[0].scopeReason, /其它窗口/);
  const delta = {
    ...x.errors,
    resourceFailures: x.errors.resourceFailures.slice(1),
    consoleErrors: x.errors.consoleErrors.slice(1),
  };
  assert.ok(buildStateBlockers(classifyExpectedQuotaErrors({ errors: delta, ...next }).scopedErrors).length > 0);
  assert.equal(old.responses[0].responseOrder, null, "已交旧快照不随晚响应改写");
  const y = recorderSample();
  y.begin();
  y.recorder.markTriggerResult(true);
  const late = y.request();
  y.recorder.onRequest(late);
  y.recorder.endWindow();
  y.resource(y.response(late));
  const ended = await y.recorder.settleAndSnapshot();
  assert.equal(ended.responses[0].scopeId, ended.scope.id);
  assert.ok(ended.responses[0].responseOrder > ended.scope.endOrder);
  assert.equal(ended.responses[0].bodyReadStatus, "not-eligible");
});

test("C8-C2a：end之后新请求不属旧scope；实例身份独立及操作误用明确拒绝", async () => {
  const x = recorderSample();
  x.begin();
  x.recorder.markTriggerResult(false);
  x.recorder.endWindow();
  const outside = x.request();
  x.recorder.onRequest(outside);
  x.resource(x.response(outside));
  const snapshot = await x.recorder.settleAndSnapshot();
  assert.equal(snapshot.responses.length, 0);
  assert.equal(snapshot.scope.triggerSucceeded, false);
  const y = recorderSample();
  y.begin();
  y.recorder.endWindow();
  const other = await y.recorder.settleAndSnapshot();
  assert.notEqual(snapshot.scope.pageId, other.scope.pageId);
  const z = recorderSample();
  await assert.rejects(z.recorder.settleAndSnapshot(), /begin/);
  z.begin();
  assert.throws(() => z.begin(), /尚未结束/);
  z.recorder.markTriggerResult(true);
  assert.throws(() => z.recorder.markTriggerResult(true), /仅记录一次/);
});

test("C8-C2a：其它真实code不预填、成功收尾清除1000ms timer", async (t) => {
  const set = t.mock.method(globalThis, "setTimeout");
  const clear = t.mock.method(globalThis, "clearTimeout");
  const x = recorderSample();
  x.begin();
  x.recorder.markTriggerResult(true);
  const req = x.request();
  x.recorder.onRequest(req);
  x.resource(x.response(req, { body: async () => Buffer.from('{"code":"OTHER_BUSINESS_ERROR"}') }));
  x.consoleMessage();
  x.recorder.endWindow();
  const snapshot = await x.recorder.settleAndSnapshot();
  assert.equal(snapshot.responses[0].bodyReadStatus, "parsed");
  assert.equal(snapshot.responses[0].bodyCode, "OTHER_BUSINESS_ERROR");
  assert.ok(
    buildStateBlockers(classifyExpectedQuotaErrors({ errors: x.delta(), ...snapshot }).scopedErrors).length > 0,
  );
  const bounded = set.mock.calls.find((call) => call.arguments[1] === 1000);
  assert.ok(bounded);
  assert.ok(clear.mock.calls.some((call) => call.arguments[0] === bounded.result));
});

async function modeContextFixture({ brokenHook = false } = {}) {
  const source = readFileSync(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("async function createModeContext(");
  const end = source.indexOf("/**\n * 模块放行后的运行时就绪链", begin);
  assert.ok(begin >= 0 && end > begin);
  const page = new EventEmitter();
  page.route = async () => {};
  page.unroute = async () => {};
  const context = new EventEmitter();
  context.newPage = async () => page;
  context.route = async () => {};
  context.addInitScript = async () => {};
  context.close = async () => {};
  const hookCalls = [];
  const create = runInNewContext(`${source.slice(begin, end)}\ncreateModeContext`, {
    BASE_VIEWPORT: { width: 1920, height: 1080 },
    URL,
    createQuotaEvidenceRecorder: (options) => {
      const recorder = createQuotaEvidenceRecorder(options);
      for (const method of ["onRequest", "onResponse", "onConsole"]) {
        const original = recorder[method];
        recorder[method] = (...args) => {
          hookCalls.push({
            method,
            index: args[1],
            resourceCount: options.errors.resourceFailures.length,
            consoleCount: options.errors.consoleErrors.length,
          });
          if (brokenHook && method === "onRequest") throw new Error("native recorder hook failed");
          return original(...args);
        };
      }
      return recorder;
    },
    buildPreferenceSeedSource: () => "seed",
    APP_MODULE_ROUTE: /app.js/,
    PRICING_REFRESH_ROUTE: /pricing/,
    installBrowserColorObserver: () => {},
    pricingRefreshFulfillBody: () => "{}",
  });
  const ctx = await create({
    browser: { newContext: async () => context },
    previewUrl: "http://127.0.0.1:12581/",
    mode: "light",
    skinId: "chatgpt",
  });
  return { ctx, context, page, hookCalls };
}

test("C8-C2b：实际createModeContext原handler先记raw再hook，所有响应都传递", async () => {
  const x = await modeContextFixture();
  const recorder = x.ctx.quotaEvidence;
  recorder.begin({ mode: "light", attempt: 1, unitId: "quota-toast", stateId: "quota-toast" });
  recorder.markTriggerResult(true);
  const request = { url: () => quotaUrl, method: () => "GET", frame: () => ({ page: () => x.page }) };
  x.context.emit("request", request);
  x.context.emit("response", {
    request: () => request,
    url: () => quotaUrl,
    status: () => 409,
    body: async () => Buffer.from('{"code":"QUOTA_WINDOW_UNAVAILABLE"}'),
  });
  x.page.emit("console", { type: () => "error", text: () => text, location: () => ({ url: quotaUrl }) });
  const other = { ...request, url: () => `${quotaUrl}&other=1` };
  x.context.emit("request", other);
  x.context.emit("response", {
    request: () => other,
    url: other.url,
    status: () => 200,
    body: () => {
      throw new Error("200 must not be read");
    },
  });
  recorder.endWindow();
  const snapshot = await recorder.settleAndSnapshot();
  assert.equal(snapshot.responses.length, 2);
  assert.equal(snapshot.responses[1].status, 200);
  const responseCalls = x.hookCalls.filter((call) => call.method === "onResponse");
  assert.equal(responseCalls[0].index, 0);
  assert.equal(responseCalls[0].resourceCount, 1);
  assert.equal(responseCalls[1].index, undefined);
  assert.equal(responseCalls[1].resourceCount, 1);
  const consoleCall = x.hookCalls.find((call) => call.method === "onConsole");
  assert.equal(consoleCall.index, 0);
  assert.equal(consoleCall.consoleCount, 1);
  assert.equal(x.ctx.errors.resourceFailures[0].status, 409);
  assert.equal(x.ctx.errors.consoleErrors[0], text);
  assert.deepEqual(
    buildStateBlockers(classifyExpectedQuotaErrors({ errors: x.ctx.errors, ...snapshot }).scopedErrors),
    [],
  );
  await x.ctx.close();
});

test("C8-C2b：原handler hook异常留诊断并停用坏记录器，raw错误不丢", async () => {
  const x = await modeContextFixture({ brokenHook: true });
  const request = { url: () => quotaUrl, method: () => "GET", frame: () => ({ page: () => x.page }) };
  assert.doesNotThrow(() => x.context.emit("request", request));
  assert.equal(x.ctx.quotaEvidence, null);
  assert.equal(x.ctx.quotaEvidenceErrors.length, 1);
  x.context.emit("response", { request: () => request, url: () => quotaUrl, status: () => 409 });
  x.page.emit("console", { type: () => "error", text: () => text, location: () => ({ url: quotaUrl }) });
  assert.equal(buildStateBlockers(x.ctx.errors).length, 2);
  assert.match(x.ctx.quotaEvidenceErrors[0].message, /native recorder hook failed/);
  await x.ctx.close();
});
