import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WindowsSourceProof } from "../../src/usage-source-native.js";
import {
  captureUsageSourcePrefix,
  usageSourceIdentity,
  UsageSourceProof,
  USAGE_SOURCE_SHA_KIND,
  verifyUsageSourcePrefix,
} from "../../src/usage-source-proof.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const helperPath = path.join(projectRoot, "native/windows-source-proof/bin/windows-source-proof.exe");
const outputDirectory = path.join(projectRoot, "output/architecture-20261104/q6/single-file");
const resultPath = path.join(outputDirectory, "result.json");
const NATIVE_KIND = "ntfs-usn-v1";
const MAX_FIXTURE_BYTES = 1024 * 1024;
const JUNCTION_FALLBACK_NOTICE = "受控回退验证，非产品自动处理已实现";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function settle(run) {
  try {
    return { value: await run(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function errorText(error) {
  return error ? `${error.code || error.name}: ${error.message}` : null;
}

function tokenField(token, index) {
  return typeof token === "string" ? token.split(":")[index] ?? null : null;
}

function proofSummary(value, error) {
  if (error) return { returnKind: `error:${error.code || error.name}`, ok: false, actual: errorText(error) };
  if (!value) return { returnKind: "null", ok: false, actual: "null" };
  const token = value.validation?.token;
  return {
    returnKind: value.kind ?? value.validation?.kind ?? null,
    ok: true,
    actual: "proof result",
    offset: value.offset ?? value.validation?.offset ?? null,
    readBytes: value.readBytes ?? null,
    journalBytes: value.journalBytes ?? null,
    nativeIdentity: tokenField(token, 4),
    sealUsn: tokenField(token, 2),
  };
}

function nativeAccept(verified, advanced, oldOffset, newOffset) {
  if (!verified || !advanced) return { passed: false, failureReason: "native unavailable (null); must not count as a pass" };
  if (verified.kind !== NATIVE_KIND || advanced.validation?.kind !== NATIVE_KIND)
    return { passed: false, failureReason: "native proof kind mismatch" };
  if (verified.offset !== oldOffset || advanced.validation.offset !== newOffset)
    return { passed: false, failureReason: "native proof offset mismatch" };
  if (verified.readBytes !== 0 || advanced.readBytes !== 0)
    return { passed: false, failureReason: "native proof read source bytes" };
  if (!(verified.journalBytes > 0) || !(advanced.journalBytes > 0))
    return { passed: false, failureReason: "native proof did not report bounded journal work" };
  return { passed: true, failureReason: null };
}

function nativeUnavailableCannotPass(baseline, verified, advanced, freshBegin, expectedAccept, helperReason) {
  if (!baseline?.available) return { passed: false, failureReason: "native unavailable at baseline; must not count as a pass" };
  if (expectedAccept) return nativeAccept(verified, advanced, baseline.offset, advanced?.validation?.offset ?? baseline.offset);
  if (!freshBegin?.value) return { passed: false, failureReason: "native unavailable after mutation; a null rejection cannot count as a pass" };
  if (!helperReason?.reason) return { passed: false, failureReason: "native helper gave no concrete rejection reason" };
  if (verified?.value && advanced?.value) return { passed: false, failureReason: "native accepted an unsafe mutation" };
  return { passed: true, failureReason: null };
}

function selfCheck() {
  const token = `${NATIVE_KIND}:1:2:${"0".repeat(16)}:${"1".repeat(32)}:${"0".repeat(16)}:0:8:8`;
  const verified = { kind: NATIVE_KIND, offset: 8, readBytes: 0, journalBytes: 168, validation: { kind: NATIVE_KIND, offset: 8, token } };
  const advanced = { readBytes: 0, journalBytes: 168, validation: { kind: NATIVE_KIND, offset: 16, token } };
  assert.equal(nativeAccept(verified, advanced, 8, 16).passed, true);
  assert.match(nativeAccept(null, advanced, 8, 16).failureReason, /native unavailable.*must not count/);
  assert.match(nativeAccept(verified, null, 8, 16).failureReason, /native unavailable.*must not count/);
  assert.equal(nativeAccept(verified, advanced, 8, 17).passed, false);
  assert.equal(
    nativeUnavailableCannotPass({ available: false, offset: 8 }, null, null, { value: verified }, false, { reason: "x" }).passed,
    false,
  );
  assert.equal(
    nativeUnavailableCannotPass({ available: true, offset: 8 }, { value: verified }, { value: advanced }, { value: verified }, false, { reason: "x" }).passed,
    false,
  );
  assert.equal(USAGE_SOURCE_SHA_KIND !== NATIVE_KIND, true, "the SHA fallback must be distinct from native proof");
  console.log("Q6_SELF_CHECK native-null-is-not-pass=ok native-kind-and-offsets=ok native-vs-sha-distinct=ok");
}

class RawReasonHelper {
  constructor(executable) {
    this.child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.sequence = 0;
    this.broken = null;
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (error) => this.fail(errorText(error)));
    this.child.on("exit", () => this.fail("raw helper exited"));
    this.child.stdin.on("error", (error) => this.fail(errorText(error)));
  }

  onData(chunk) {
    if (this.buffer.length + chunk.length > MAX_FIXTURE_BYTES) return this.fail("raw helper response exceeded 1 MiB");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const end = this.buffer.indexOf(10);
    if (end < 0) return;
    const line = this.buffer.subarray(0, end).toString("utf8");
    this.buffer = this.buffer.subarray(end + 1);
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return this.fail("raw helper returned malformed JSON");
    }
    const pending = this.pending;
    if (!pending || response.id !== pending.id) return this.fail("raw helper response id mismatch");
    if (this.buffer.length) return this.fail("raw helper returned trailing bytes");
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  fail(reason) {
    this.broken = reason;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, available: false, reason });
  }

  async request(payload) {
    if (this.broken) return { ok: false, available: false, reason: this.broken };
    const id = ++this.sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail(`raw helper timed out: ${this.stderr}`), 4000);
      this.pending = { id, resolve, timer };
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  async close() {
    this.fail("raw helper closed");
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // The helper may already have closed its stdin.
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function note(state, target, operation) {
  state.writePaths.push({ path: target, operation });
}

async function writeSmall(state, file, bytes, operation = "writeFile") {
  assert.ok(bytes.length < MAX_FIXTURE_BYTES);
  await writeFile(file, bytes);
  note(state, file, operation);
}

async function makeCase(state, id, initial) {
  const directory = path.join(state.root, id);
  await mkdir(directory);
  note(state, directory, "mkdir");
  const file = path.join(directory, "source.jsonl");
  await writeSmall(state, file, initial, "writeFile initial");
  return { id, directory, file, initial: Buffer.from(initial), expected: Buffer.from(initial), before: await stat(file) };
}

function makeBridge(state) {
  const bridge = new WindowsSourceProof(helperPath);
  const proof = new UsageSourceProof();
  proof.provider = async () => (proof.closed ? null : bridge);
  proof.native = bridge;
  state.bridgeInstances += 1;
  return {
    bridge,
    proof,
    close() {
      proof.close();
      state.bridgeClosed += 1;
    },
  };
}

async function rawReason(raw, op, file, token, offset) {
  const exact = await stat(file, { bigint: true });
  const requestOffset = op === "begin" ? 0 : offset;
  const payload = {
    op,
    path: file,
    offset: requestOffset,
    expected: { size: String(exact.size), mtimeNs: String(exact.mtimeNs) },
  };
  if (token) payload.token = token;
  const response = await raw.request(payload);
  return {
    op,
    offset: requestOffset,
    returnKind: response.kind ?? (response.ok ? "helper-ok" : "helper-error"),
    helperOk: response.ok === true,
    helperAvailable: response.available === true,
    reason: response.reason ?? null,
  };
}

async function establish(proof, raw, file) {
  const info = await stat(file);
  const begin = await settle(() => proof.begin(file, info));
  const beginSummary = proofSummary(begin.value, begin.error);
  let initial = { value: null, error: null };
  if (begin.value) initial = await settle(() => proof.capture(file, info.size, info, begin.value));
  const initialSummary = proofSummary(initial.value, initial.error);
  const shaInitial = await settle(() => captureUsageSourcePrefix(file, info.size, info));
  const helperReason =
    !begin.value || (!initial.value && !initial.error)
      ? await rawReason(raw, !begin.value ? "begin" : "advance", file, begin.value?.validation?.token ?? initial.value?.validation?.token ?? null, info.size)
      : null;
  const available = Boolean(begin.value && initial.value && shaInitial.value);
  return {
    available,
    info,
    offset: info.size,
    nativeValidation: initial.value?.validation ?? null,
    shaValidation: shaInitial.value?.validation ?? null,
    shaReadBytes: shaInitial.value?.readBytes ?? null,
    nativeIdentity: tokenField(initial.value?.validation?.token, 4),
    begin: beginSummary,
    initialCapture: initialSummary,
    shaBaseline: proofSummary(shaInitial.value, shaInitial.error),
    helperReason,
  };
}

async function fallbackRound(file, baseline, info) {
  const verified = await settle(() => verifyUsageSourcePrefix(file, baseline.shaValidation, baseline.offset, info));
  let advanced = { value: null, error: null };
  if (verified.value) advanced = await settle(() => captureUsageSourcePrefix(file, info.size, info, verified.value));
  const bytes = await readFile(file);
  const accepted = Boolean(
    verified.value?.kind === USAGE_SOURCE_SHA_KIND &&
      advanced.value?.validation?.kind === USAGE_SOURCE_SHA_KIND &&
      advanced.value.validation.digest === sha(bytes.subarray(0, info.size)),
  );
  const oldPrefixDigest = bytes.length >= baseline.offset ? sha(bytes.subarray(0, baseline.offset)) : null;
  const rootCause = {
    sizeDecreased: info.size < baseline.offset,
    identityChanged: baseline.shaValidation?.identity !== usageSourceIdentity(info),
    oldPrefixDigestChanged: oldPrefixDigest !== baseline.shaValidation?.digest,
    ctimeChanged: baseline.shaValidation?.ctimeMs !== info.ctimeMs,
  };
  return {
    kind: "sha-fallback",
    nativePassed: false,
    expectedAccept: null,
    verify: proofSummary(verified.value, verified.error),
    capture: proofSummary(advanced.value, advanced.error),
    returnKind: verified.value?.kind ?? `error:${verified.error?.code || verified.error?.name || "null"}`,
    accepted,
    readBytes: (verified.value?.readBytes ?? 0) + (advanced.value?.readBytes ?? 0),
    rootCause,
    failureReason: accepted
      ? null
      : `SHA fallback rejected append contract: ${Object.entries(rootCause).filter(([, value]) => value).map(([key]) => key).join(", ") || "verification/capture unavailable"}`,
  };
}

function fallbackPassed(fallback, expectedAccept) {
  fallback.expectedAccept = expectedAccept;
  const cause = fallback.rootCause;
  const justifiedRejection = cause.sizeDecreased || cause.identityChanged || cause.oldPrefixDigestChanged;
  return fallback.nativePassed === false && fallback.accepted === expectedAccept && (expectedAccept || justifiedRejection);
}

async function treeBytes(root) {
  let total = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    }
  }
  await walk(root);
  return total;
}

async function runAppend20(state, raw) {
  const fixture = await makeCase(state, "01-append-20", Buffer.alloc(4096, 65));
  const writer = await open(fixture.file, "a");
  state.handles.push(writer);
  const bridge = makeBridge(state);
  const result = {
    id: fixture.id,
    planItem: 1,
    proofPath: "native-bridge",
    expected: "20 appends through one handle opened before baseline; after each fsync, native verify and advance certify every completed write",
    actual: null,
    returnKind: null,
    failureReason: null,
    passed: false,
    file: fixture.file,
    writerOpenedBeforeBaseline: true,
    steps: [],
  };
  try {
    const baseline = await establish(bridge.proof, raw, fixture.file);
    result.nativeBaseline = { available: baseline.available, ...baseline.begin, initialCapture: baseline.initialCapture };
    if (!baseline.available) throw new Error("native baseline unavailable; appends cannot be certified as native passes");
    let validation = baseline.nativeValidation;
    let offset = baseline.offset;
    for (let step = 1; step <= 20; step += 1) {
      const bytes = Buffer.from(`${JSON.stringify({ q6: "single", step, bytes: "appended" })}\n`);
      await writer.write(bytes);
      await writer.sync();
      note(state, fixture.file, `append+fsync step ${step}`);
      fixture.expected = Buffer.concat([fixture.expected, bytes]);
      const actualBytes = await readFile(fixture.file);
      assert.deepEqual(actualBytes, fixture.expected);
      assert.ok(actualBytes.length < MAX_FIXTURE_BYTES);
      const info = await stat(fixture.file);
      const verified = await settle(() => bridge.proof.verify(fixture.file, validation, offset, info));
      let advanced = { value: null, error: null };
      if (verified.value) advanced = await settle(() => bridge.proof.capture(fixture.file, info.size, info, verified.value));
      const classification = nativeAccept(verified.value, advanced.value, offset, info.size);
      const helperReason = classification.passed
        ? null
        : await rawReason(
            raw,
            verified.value ? "advance" : "verify",
            fixture.file,
            verified.value?.validation?.token ?? validation.token,
            verified.value ? info.size : offset,
          );
      result.steps.push({
        step,
        expected: { size: info.size, sha256: sha(fixture.expected), nativeVerify: NATIVE_KIND, nativeAdvanceOffset: info.size },
        actual: { size: actualBytes.length, sha256: sha(actualBytes), flush: "fsync" },
        verify: proofSummary(verified.value, verified.error),
        advance: proofSummary(advanced.value, advanced.error),
        returnKind: advanced.value?.validation?.kind ?? verified.value?.kind ?? "native-unavailable:null",
        failureReason: classification.failureReason ?? helperReason?.reason ?? errorText(verified.error) ?? errorText(advanced.error),
        passed: classification.passed,
      });
      if (!classification.passed) break;
      validation = advanced.value.validation;
      offset = info.size;
    }
    const finalInfo = await stat(fixture.file);
    const fallback = await fallbackRound(fixture.file, baseline, finalInfo);
    result.shaFallback = fallback;
    result.returnKind = result.steps.every((step) => step.passed) ? `native:${NATIVE_KIND}` : "native-unavailable:null/error";
    result.nativeAccepted = result.steps.every((step) => step.passed);
    result.actual = `${result.steps.length}/20 native verify+advance intervals accepted; SHA fallback ${fallback.accepted ? "accepted" : "rejected"}`;
    result.passed = result.steps.length === 20 && result.steps.every((step) => step.passed) && fallbackPassed(fallback, true);
    result.failureReason = result.passed ? null : result.steps.find((step) => !step.passed)?.failureReason ?? fallback.failureReason;
  } catch (error) {
    result.failureReason = errorText(error);
  } finally {
    bridge.close();
    await writer.close().catch(() => {});
  }
  return result;
}

async function runMutation(state, raw, spec) {
  const fixture = await makeCase(state, spec.id, spec.initial ?? Buffer.alloc(4096, 65));
  const bridge = makeBridge(state);
  const result = {
    id: spec.id,
    planItem: spec.planItem,
    proofPath: "native-bridge",
    expected: spec.expected,
    actual: null,
    returnKind: null,
    failureReason: null,
    passed: false,
    file: fixture.file,
  };
  try {
    if (spec.beforeBaseline) await spec.beforeBaseline(state, fixture);
    const baseline = await establish(bridge.proof, raw, fixture.file);
    result.nativeBaseline = { available: baseline.available, ...baseline.begin, initialCapture: baseline.initialCapture };
    if (!baseline.available) throw new Error("native baseline unavailable; a null rejection cannot count as a pass");
    result.mutation = await spec.mutate(state, fixture);
    const after = await stat(fixture.file);
    const verified = await settle(() => bridge.proof.verify(fixture.file, baseline.nativeValidation, baseline.offset, after));
    let advanced = { value: null, error: null };
    if (verified.value) advanced = await settle(() => bridge.proof.capture(fixture.file, after.size, after, verified.value));
    const helperReason =
      verified.value && advanced.value
        ? null
        : await rawReason(
            raw,
            verified.value ? "advance" : "verify",
            fixture.file,
            verified.value?.validation?.token ?? baseline.nativeValidation.token,
            verified.value ? after.size : baseline.offset,
          );
    const freshBegin = await settle(() => bridge.proof.begin(fixture.file, after));
    const freshSummary = proofSummary(freshBegin.value, freshBegin.error);
    const freshIdentity = tokenField(freshBegin.value?.validation?.token, 4);
    const fallback = await fallbackRound(fixture.file, baseline, after);
    const contractReason = helperReason?.reason ?? errorText(advanced.error) ?? errorText(verified.error);
    const classification = nativeUnavailableCannotPass(baseline, verified, advanced, freshBegin, false, helperReason);
    const reasonMatches = spec.reason.test(contractReason ?? "");
    const identityCondition = spec.identityChanged === undefined || (spec.identityChanged ? freshIdentity !== baseline.nativeIdentity : freshIdentity === baseline.nativeIdentity);
    result.verify = proofSummary(verified.value, verified.error);
    result.advance = proofSummary(advanced.value, advanced.error);
    result.helperReason = helperReason;
    result.freshBaseline = { ...freshSummary, nativeIdentity: freshIdentity, identityChanged: freshIdentity !== baseline.nativeIdentity };
    result.shaFallback = fallback;
    result.rejectionReason = contractReason;
    result.nativeFailureReason = contractReason;
    result.shaFallbackRejectionReason = fallback.failureReason;
    result.returnKind = verified.value?.kind ? `native:${verified.value.kind}` : `native-unavailable:null${verified.error ? `/error:${verified.error.code || verified.error.name}` : ""}`;
    result.nativeAccepted = Boolean(verified.value && advanced.value);
    result.actual = `native verify ${result.verify.ok ? "accepted" : "rejected"}, advance ${result.advance.ok ? "accepted" : "rejected"}; fresh baseline ${freshSummary.ok ? "available" : "unavailable"}; SHA fallback ${fallback.accepted ? "accepted" : "rejected"}`;
    result.passed = classification.passed && reasonMatches && identityCondition && fallbackPassed(fallback, false);
    result.failureReason =
      result.passed ? null : classification.failureReason ?? (!reasonMatches ? `unexpected native reason: ${contractReason}` : !identityCondition ? "fresh baseline identity condition failed" : fallback.failureReason);
    if (!fallbackPassed(fallback, false)) result.failureReason = `${result.failureReason ?? ""}; SHA fallback contract failed`;
  } catch (error) {
    result.failureReason = errorText(error);
  } finally {
    bridge.close();
  }
  return result;
}

async function runHardlink(state, raw) {
  const fixture = await makeCase(state, "07-hardlink-alias-append", Buffer.alloc(4096, 65));
  const alias = path.join(fixture.directory, "alias.jsonl");
  await link(fixture.file, alias);
  note(state, alias, "hardlink to source");
  const sourceInfo = await stat(fixture.file);
  const aliasInfo = await stat(alias);
  const writer = await open(alias, "a");
  state.handles.push(writer);
  const bridge = makeBridge(state);
  const result = {
    id: fixture.id,
    planItem: 5,
    proofPath: "native-bridge",
    expected: "append through a hardlink alias opened before baseline; native proof bound to the source path sees the same file identity and accepts",
    actual: null,
    returnKind: null,
    failureReason: null,
    passed: false,
    file: fixture.file,
    alias,
  };
  try {
    const baseline = await establish(bridge.proof, raw, fixture.file);
    result.nativeBaseline = { available: baseline.available, ...baseline.begin, initialCapture: baseline.initialCapture };
    if (!baseline.available) throw new Error("native baseline unavailable; alias append cannot count as a native pass");
    const bytes = Buffer.from('{"q6":"hardlink-alias","write":1}\n');
    await writer.write(bytes);
    await writer.sync();
    note(state, alias, "append+fsync through hardlink alias");
    fixture.expected = Buffer.concat([fixture.expected, bytes]);
    const actualBytes = await readFile(fixture.file);
    assert.deepEqual(actualBytes, fixture.expected);
    const after = await stat(fixture.file);
    const verified = await settle(() => bridge.proof.verify(fixture.file, baseline.nativeValidation, baseline.offset, after));
    let advanced = { value: null, error: null };
    if (verified.value) advanced = await settle(() => bridge.proof.capture(fixture.file, after.size, after, verified.value));
    const classification = nativeAccept(verified.value, advanced.value, baseline.offset, after.size);
    const helperReason = classification.passed
      ? null
      : await rawReason(raw, verified.value ? "advance" : "verify", fixture.file, verified.value?.validation?.token ?? baseline.nativeValidation.token, verified.value ? after.size : baseline.offset);
    const fallback = await fallbackRound(fixture.file, baseline, after);
    result.identity = {
      sourceNlink: sourceInfo.nlink,
      aliasNlink: aliasInfo.nlink,
      sameNodeIdentity: usageSourceIdentity(sourceInfo) === usageSourceIdentity(aliasInfo),
      nativeIdentity: baseline.nativeIdentity,
    };
    result.verify = proofSummary(verified.value, verified.error);
    result.advance = proofSummary(advanced.value, advanced.error);
    result.helperReason = helperReason;
    result.shaFallback = fallback;
    result.returnKind = advanced.value?.validation?.kind ? `native:${advanced.value.validation.kind}` : `native-unavailable:${verified.error ? `error:${verified.error.code || verified.error.name}` : "null"}`;
    result.nativeAccepted = classification.passed;
    result.actual = `native ${classification.passed ? "accepted" : "rejected"} alias write; SHA fallback ${fallback.accepted ? "accepted" : "rejected"}`;
    result.passed = classification.passed && result.identity.sameNodeIdentity && Number(sourceInfo.nlink) >= 2 && fallbackPassed(fallback, true);
    result.failureReason = result.passed ? null : classification.failureReason ?? helperReason?.reason ?? "hardlink identity or SHA fallback contract failed";
  } catch (error) {
    result.failureReason = errorText(error);
  } finally {
    bridge.close();
    await writer.close().catch(() => {});
  }
  return result;
}

class ShaOnlyProof extends UsageSourceProof {
  async provider() {
    return null;
  }
}

async function runReparseFallback(state) {
  const fixture = await makeCase(state, "08-reparse-explicit-fallback", Buffer.alloc(4096, 65));
  const external = path.join(fixture.directory, "external");
  const aliasRoot = path.join(fixture.directory, "junction");
  const aliasFile = path.join(aliasRoot, "source.jsonl");
  const result = {
    id: fixture.id,
    planItem: 5,
    proofPath: "sha-fallback",
    expected: "controlled SHA fallback validation: the probe manually uses lstat and ShaOnlyProof for a directory junction alias; native proof is not claimed",
    actual: null,
    returnKind: USAGE_SOURCE_SHA_KIND,
    failureReason: null,
    passed: false,
    file: fixture.file,
    aliasFile,
    controlledFallback: {
      mechanism: "ShaOnlyProof plus manual lstat selection by this probe",
      productAutomaticGuardImplemented: false,
      disclaimer: JUNCTION_FALLBACK_NOTICE,
    },
  };
  const proof = new ShaOnlyProof();
  try {
    await mkdir(external);
    note(state, external, "mkdir external target");
    await rename(fixture.file, path.join(external, "source.jsonl"));
    note(state, fixture.file, "rename source into external target");
    note(state, path.join(external, "source.jsonl"), "rename destination");
    await symlink(external, aliasRoot, "junction");
    note(state, aliasRoot, "directory junction to external target");
    const lstatInfo = await lstat(aliasRoot);
    const info = await stat(aliasFile);
    const baseline = await settle(() => proof.capture(aliasFile, info.size, info, null));
    if (!baseline.value) throw new Error(errorText(baseline.error) ?? "SHA baseline unavailable");
    const bytes = Buffer.from('{"q6":"junction-alias","write":1}\n');
    const handle = await open(aliasFile, "a");
    state.handles.push(handle);
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    note(state, aliasFile, "append+fsync through junction alias");
    const after = await stat(aliasFile);
    const verified = await settle(() => proof.verify(aliasFile, baseline.value.validation, info.size, after));
    const advanced = verified.value ? await settle(() => proof.capture(aliasFile, after.size, after, verified.value)) : { value: null, error: null };
    const fallback = await fallbackRound(
      aliasFile,
      { shaValidation: baseline.value.validation, offset: info.size },
      after,
    );
    const fallbackAccepted = fallbackPassed(fallback, true);
    result.actual = `lstat junction=${lstatInfo.isSymbolicLink()}; native helper invoked=false; SHA verify/capture ${fallbackAccepted ? "accepted" : "rejected"}; ${JUNCTION_FALLBACK_NOTICE}`;
    result.verify = proofSummary(verified.value, verified.error);
    result.capture = proofSummary(advanced.value, advanced.error);
    result.shaFallback = fallback;
    result.returnKind = `sha-fallback:${USAGE_SOURCE_SHA_KIND}`;
    result.failureReason = lstatInfo.isSymbolicLink() && fallbackAccepted ? null : fallback.failureReason ?? "reparse alias was not explicitly handled by SHA fallback";
    result.passed = lstatInfo.isSymbolicLink() && fallbackAccepted;
  } catch (error) {
    result.failureReason = errorText(error);
  } finally {
    proof.close();
  }
  return result;
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.ok(existsSync(helperPath), `missing precompiled helper: ${helperPath}`);
  const tempBase = await realpath(os.tmpdir());
  const root = path.join(tempBase, `q6-single-${randomBytes(8).toString("hex")}`);
  assert.equal(path.dirname(root), tempBase);
  assert.equal(path.win32.parse(root).root.toUpperCase(), "C:\\");
  const state = {
    startedAt: new Date().toISOString(),
    root,
    writePaths: [],
    handles: [],
    bridgeInstances: 0,
    bridgeClosed: 0,
    rootCreated: false,
    cleanup: null,
    fixtureBytes: null,
  };
  let raw = null;
  let rawStats = null;
  const cases = [];
  try {
    await mkdir(root);
    state.rootCreated = true;
    note(state, root, "mkdir isolated C temp root");
    raw = new RawReasonHelper(helperPath);
    rawStats = await raw.request({ op: "stats" });
    cases.push(await runAppend20(state, raw));
    const before = Buffer.alloc(4096, 65);
    const restoreMtime = async (stateRef, fixture) => {
      await utimes(fixture.file, fixture.before.atime, fixture.before.mtime);
      note(stateRef, fixture.file, "restore original mtime");
      const after = await stat(fixture.file);
      return { mtimeMsBefore: fixture.before.mtimeMs, mtimeMsAfter: after.mtimeMs, restored: Math.abs(after.mtimeMs - fixture.before.mtimeMs) < 0.001 };
    };
    const inPlaceRewrite = async (stateRef, fixture, append) => {
      const handle = await open(fixture.file, "r+");
      try {
        const rewrite = Buffer.alloc(32, 66);
        await handle.write(rewrite, 0, rewrite.length, 64);
        await handle.sync();
        note(stateRef, fixture.file, "old-prefix in-place rewrite at byte 64");
        rewrite.copy(fixture.expected, 64);
        if (append) {
          const suffix = Buffer.from('{"q6":"mixed-overwrite-append"}\n');
          await handle.write(suffix, 0, suffix.length, fixture.expected.length);
          await handle.sync();
          note(stateRef, fixture.file, "append after old-prefix rewrite");
          fixture.expected = Buffer.concat([fixture.expected, suffix]);
        }
      } finally {
        await handle.close();
      }
      assert.deepEqual(await readFile(fixture.file), fixture.expected);
      return restoreMtime(stateRef, fixture);
    };
    cases.push(
      await runMutation(state, raw, {
        id: "02-mixed-overwrite-append-restored-mtime",
        planItem: 2,
        expected: "old-prefix overwrite plus append with restored mtime must not be accepted as append-only",
        reason: /journal interval contains unsafe reasons|source file identity changed|source size decreased|cursor offset is beyond the source size/,
        mutate: (stateRef, fixture) => inPlaceRewrite(stateRef, fixture, true),
      }),
    );
    cases.push(
      await runMutation(state, raw, {
        id: "03-same-size-rewrite-restored-mtime",
        planItem: 2,
        expected: "same-size old-prefix overwrite with size and mtime restored must not be accepted",
        reason: /journal interval contains unsafe reasons|source file identity changed|source size decreased|cursor offset is beyond the source size/,
        mutate: (stateRef, fixture) => inPlaceRewrite(stateRef, fixture, false),
      }),
    );
    cases.push(
      await runMutation(state, raw, {
        id: "04-truncate",
        planItem: 3,
        expected: "truncation below the certified offset must be rejected and the identity must be recertified",
        initial: Buffer.alloc(8192, 65),
        reason: /cursor offset is beyond the source size|source size decreased|journal interval contains unsafe reasons/,
        identityChanged: false,
        mutate: async (stateRef, fixture) => {
          const handle = await open(fixture.file, "r+");
          try {
            await handle.truncate(4096);
            await handle.sync();
          } finally {
            await handle.close();
          }
          note(stateRef, fixture.file, "truncate 8192 to 4096+fsync");
          const bytes = await readFile(fixture.file);
          assert.equal(bytes.length, 4096);
          return { sizeAfter: bytes.length, sizeBefore: fixture.before.size };
        },
      }),
    );
    cases.push(
      await runMutation(state, raw, {
        id: "05-delete-recreate-same-metadata",
        planItem: 3,
        expected: "delete and same-size, same-mtime recreation must establish a different file identity",
        reason: /source file identity changed|journal interval contains unsafe reasons|cursor offset is beyond the source size/,
        identityChanged: true,
        mutate: async (stateRef, fixture) => {
          await unlink(fixture.file);
          note(stateRef, fixture.file, "unlink source");
          const replacement = Buffer.alloc(4096, 68);
          await writeSmall(stateRef, fixture.file, replacement, "recreate source at same path");
          await utimes(fixture.file, fixture.before.atime, fixture.before.mtime);
          note(stateRef, fixture.file, "restore original mtime on recreated source");
          const after = await stat(fixture.file);
          return { sizeAfter: after.size, mtimeMsBefore: fixture.before.mtimeMs, mtimeMsAfter: after.mtimeMs };
        },
      }),
    );
    cases.push(
      await runMutation(state, raw, {
        id: "06-same-size-replacement",
        planItem: 3,
        expected: "same-size, same-mtime replacement over the source path must establish a different file identity",
        reason: /source file identity changed|journal interval contains unsafe reasons|cursor offset is beyond the source size/,
        identityChanged: true,
        mutate: async (stateRef, fixture) => {
          const replacementPath = path.join(fixture.directory, "replacement.jsonl");
          await writeSmall(stateRef, replacementPath, Buffer.alloc(4096, 69), "write same-size replacement");
          await utimes(replacementPath, fixture.before.atime, fixture.before.mtime);
          note(stateRef, replacementPath, "restore original mtime on replacement");
          await rename(replacementPath, fixture.file);
          note(stateRef, replacementPath, "rename replacement source");
          note(stateRef, fixture.file, "replace source path");
          const after = await stat(fixture.file);
          return { sizeAfter: after.size, mtimeMsBefore: fixture.before.mtimeMs, mtimeMsAfter: after.mtimeMs };
        },
      }),
    );
    cases.push(await runHardlink(state, raw));
    cases.push(await runReparseFallback(state));
    state.fixtureBytes = await treeBytes(root);
    assert.ok(state.fixtureBytes < MAX_FIXTURE_BYTES, `isolated fixture exceeded 1 MiB: ${state.fixtureBytes}`);
    const nativeAcceptedBoundaries =
      (cases[0].steps ?? []).filter((step) => step.passed).length +
      cases.slice(1).filter((row) => row.nativeAccepted).length;
    const finishedAt = new Date().toISOString();
    state.report = {
      startedAt: state.startedAt,
      finishedAt,
      elapsedMs: Date.parse(finishedAt) - Date.parse(state.startedAt),
      scope: "single-file contract for plan items 1/2/3 (part of 5); complete directory change-list coverage is out of scope",
      platform: process.platform,
      node: process.version,
      cwd: process.cwd(),
      argv: process.argv,
      execution: {
        shell: "pwsh (PowerShell 7)",
        commandSandboxEscalation: "require_escalated",
        escalationReason: "ordinary-user access to the already-active C: NTFS journal for an isolated q6-single- fixture",
      },
      commands: [
        "node --check 'experiments\\architecture-20261101\\q6-single-file-probe.mjs'",
        "node 'experiments\\architecture-20261101\\q6-single-file-probe.mjs' --self-check",
        "node 'experiments\\architecture-20261101\\q6-single-file-probe.mjs'",
      ],
      selfCheck: "asserts native null is not a pass, native kind/offsets, and native/SHA proof kinds are distinct",
      authorizedVersionControlledWrite: {
        path: path.join(projectRoot, "experiments/architecture-20261101/q6-single-file-probe.mjs"),
        operation: "create and edit the single probe script",
      },
      helper: { path: helperPath, sha256: sha(await readFile(helperPath)), precompiled: true, journalConfigurationChanged: false },
      volumes: { activeNativeVolume: "C:", eJournalKnownUnavailable: true, eJournalProbed: false },
      rawHelper: { instances: 1, stats: rawStats, purpose: "bounded protocol responses with concrete native rejection reasons" },
      bridges: {
        instances: state.bridgeInstances,
        closed: state.bridgeClosed,
        writerChildProcesses: 0,
        maxSimultaneousHelpers: 2,
        perFileSealAtEveryCheckBoundary: true,
      },
      tempRoot: root,
      fixtureBytes: state.fixtureBytes,
      writePaths: state.writePaths,
      cleanup: state.cleanup,
      nativeUnavailableCountsAsPass: false,
      nativeAcceptedBoundaries,
      junctionFallbackNote: JUNCTION_FALLBACK_NOTICE,
      cases,
      passed:
        cases.length === 8 &&
        cases.every((row) => row.passed) &&
        state.bridgeInstances === state.bridgeClosed &&
        state.fixtureBytes < MAX_FIXTURE_BYTES,
      conclusion:
        "Single-file native proof and SHA fallback boundaries only. This probe does not establish a complete directory change list.",
    };
    return state.report;
  } finally {
    for (const handle of state.handles) await handle.close().catch(() => {});
    if (raw) await raw.close();
    if (state.rootCreated) {
      assert.ok(root.startsWith(`${tempBase}${path.sep}`) && path.basename(root).startsWith("q6-single-"));
      await rm(root, { recursive: true, force: true });
      state.cleanup = { path: root, removed: true, onlyProbeOwnedPaths: true };
    }
    if (state.report) state.report.cleanup = state.cleanup;
  }
}

if (process.argv[2] === "--self-check") {
  selfCheck();
} else {
  let report;
  const outputWrites = [
    { path: outputDirectory, operation: "mkdir recursive (private result directory)" },
    { path: resultPath, operation: "writeFile final result" },
  ];
  try {
    report = await main();
  } catch (error) {
    report = { passed: false, fatal: errorText(error), stack: error?.stack ?? null, argv: process.argv, startedAt: new Date().toISOString() };
  }
  await mkdir(outputDirectory, { recursive: true });
  report.outputWrites = outputWrites;
  report.writePaths = [...(report.writePaths ?? []), ...outputWrites];
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assert.ok(Buffer.byteLength(serialized) < MAX_FIXTURE_BYTES);
  await writeFile(resultPath, serialized);
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        resultPath,
        tempRoot: report.tempRoot ?? null,
        fatal: report.fatal ?? null,
        cases: (report.cases ?? []).map(({ id, planItem, passed, returnKind, failureReason, actual }) => ({ id, planItem, passed, returnKind, failureReason, actual })),
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}
