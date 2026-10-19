import assert from "node:assert/strict";
import test from "node:test";

import { closeCaptureMatrixResources } from "../scripts/skin-palette/capture.mjs";

async function captureThrown(operation) {
  try {
    await operation();
  } catch (error) {
    return { threw: true, error };
  }
  return { threw: false };
}

function resource(name, calls, { fails = false, error } = {}) {
  return {
    async close() {
      calls.push(name);
      if (fails) throw error;
    },
  };
}

test("closes browser then preview once when capture succeeds", async () => {
  const calls = [];

  await closeCaptureMatrixResources({
    browser: resource("browser", calls),
    preview: resource("preview", calls),
  });

  assert.deepEqual(calls, ["browser", "preview"]);
});

test("D8u2A closes browser, warning preview, then base preview", async () => {
  const calls = [];

  await closeCaptureMatrixResources({
    browser: resource("browser", calls),
    warningPreview: resource("warning", calls),
    preview: resource("base", calls),
  });

  assert.deepEqual(calls, ["browser", "warning", "base"]);
});

test("D8u2A preserves primary and all three cleanup errors in stable order", async () => {
  const calls = [];
  const operationError = new Error("matrix failed");
  const browserError = new Error("browser close failed");
  const warningError = new Error("warning close failed");
  const baseError = new Error("base close failed");
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls, { fails: true, error: browserError }),
      warningPreview: resource("warning", calls, { fails: true, error: warningError }),
      preview: resource("base", calls, { fails: true, error: baseError }),
      operationFailed: true,
      operationError,
    }),
  );

  assert.equal(result.threw, true);
  assert.ok(result.error instanceof AggregateError);
  assert.deepEqual(result.error.errors, [operationError, browserError, warningError, baseError]);
  assert.deepEqual(calls, ["browser", "warning", "base"]);
});

test("still closes preview and rethrows the original browser cleanup error", async () => {
  const calls = [];
  const browserError = new Error("browser close failed");
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls, { fails: true, error: browserError }),
      preview: resource("preview", calls),
    }),
  );

  assert.equal(result.threw, true);
  assert.strictEqual(result.error, browserError);
  assert.deepEqual(calls, ["browser", "preview"]);
});

test("preserves a lone preview cleanup error", async () => {
  const calls = [];
  const previewError = new Error("preview close failed");
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls),
      preview: resource("preview", calls, { fails: true, error: previewError }),
    }),
  );

  assert.equal(result.threw, true);
  assert.strictEqual(result.error, previewError);
  assert.deepEqual(calls, ["browser", "preview"]);
});

test("aggregates the operation, browser, and preview errors in close order", async () => {
  const calls = [];
  const operationError = new Error("capture failed");
  const browserError = new Error("browser close failed");
  const previewError = new Error("preview close failed");
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls, { fails: true, error: browserError }),
      preview: resource("preview", calls, { fails: true, error: previewError }),
      operationFailed: true,
      operationError,
    }),
  );

  assert.equal(result.threw, true);
  assert.ok(result.error instanceof AggregateError);
  assert.equal(result.error.errors.length, 3);
  assert.strictEqual(result.error.errors[0], operationError);
  assert.strictEqual(result.error.errors[1], browserError);
  assert.strictEqual(result.error.errors[2], previewError);
  assert.deepEqual(calls, ["browser", "preview"]);
});

test("rethrows a lone operation error after successful cleanup", async () => {
  const calls = [];
  const operationError = new Error("capture failed");
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls),
      preview: resource("preview", calls),
      operationFailed: true,
      operationError,
    }),
  );

  assert.equal(result.threw, true);
  assert.strictEqual(result.error, operationError);
  assert.deepEqual(calls, ["browser", "preview"]);
});

test("closes preview when browser acquisition did not complete", async () => {
  const calls = [];

  await closeCaptureMatrixResources({ browser: null, preview: resource("preview", calls) });

  assert.deepEqual(calls, ["preview"]);
});

test("preserves a non-Error operation throw value", async () => {
  const calls = [];
  const result = await captureThrown(() =>
    closeCaptureMatrixResources({
      browser: resource("browser", calls),
      preview: resource("preview", calls),
      operationFailed: true,
      operationError: null,
    }),
  );

  assert.equal(result.threw, true);
  assert.strictEqual(result.error, null);
  assert.deepEqual(calls, ["browser", "preview"]);
});
