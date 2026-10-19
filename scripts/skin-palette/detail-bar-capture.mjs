/**
 * Detail bar 三帧捕获事务（M5.2.P-C9）。
 *
 * 单 fill 入口：C4 几何 -> C3 中心条 clip -> 正常/隐藏背景/恢复验证三张
 * PNG buffer，并在每帧截图前后执行 B43 全中心条命中断言。复用
 * screenshotWithStyleAttributeGuard 与 C7 paint 事务。
 *
 * shortcut: 命中只证明每个中心条像素中心的顶层对象，不证明颜色；三帧齐全也只返回
 * captured-unvalidated。
 */

import { screenshotWithStyleAttributeGuard } from "./browser-measure.mjs";
import { probeDetailBarActiveCenterStripHits, probeDetailBarCenterStripHits } from "./detail-bar-hit-browser.mjs";
import { beginDetailBarPaintHide, restoreDetailBarPaintHide } from "./detail-bar-paint-browser.mjs";
import { probeDetailBarGeometry } from "./detail-bar-browser.mjs";
import { planDetailBarCenterStrip, validateDetailBarClipInsideShapes } from "./detail-bar-pixels.mjs";

const SCREENSHOT_OPTIONS = Object.freeze({ type: "png", fullPage: false, scale: "css", caret: "initial" });
const EXPECTED_HIT_SCOPE = "all-center-strip-pixel-centers";
const HIT_TEST_PHASES = Object.freeze([
  "beforeNormal",
  "afterNormal",
  "hidden",
  "afterBackground",
  "restored",
  "afterVerify",
]);

class CaptureRejected extends Error {}

function pxValue(value) {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : Number.NaN;
}

function noExtraStacking(entry) {
  return Boolean(
    entry &&
      entry.position === "static" &&
      entry.zIndex === "auto" &&
      entry.isolation === "auto" &&
      entry.display !== "none" &&
      entry.visibility !== "hidden" &&
      entry.opacity === "1" &&
      entry.transform === "none" &&
      entry.filter === "none" &&
      entry.mixBlendMode === "normal",
  );
}

function spotlightAdmission(spotlight) {
  if (!spotlight || typeof spotlight.active !== "boolean") {
    return { status: "rejected", reason: "spotlight-snapshot-missing" };
  }
  if (!spotlight.active) return { status: "inactive", reason: "" };
  const pseudo = spotlight.pseudo;
  const stack = spotlight.stack;
  const x = pxValue(spotlight.x);
  const y = pxValue(spotlight.y);
  const radius = pxValue(spotlight.radius);
  const emptyContent = pseudo?.content === '""' || pseudo?.content === "";
  const fourEdgesZero = ["top", "right", "bottom", "left"].every((side) => pxValue(pseudo?.inset?.[side]) === 0);
  const headingLeads = stack?.heading?.position === "relative" && stack.heading.zIndex === "1";
  const labelsLead =
    Array.isArray(stack?.labels) &&
    stack.labels.length > 0 &&
    stack.labels.every((label) => label.position === "relative" && label.zIndex === "1");
  if (
    spotlight.activeHostCount !== 1 ||
    spotlight.activeHostIsPanel !== true ||
    spotlight.host?.isolation !== "isolate" ||
    spotlight.host?.position !== "relative"
  ) {
    return { status: "rejected", reason: "spotlight-host-unproven" };
  }
  const pseudoFailures = [];
  if (!emptyContent) pseudoFailures.push("content");
  if (pseudo?.position !== "absolute") pseudoFailures.push("position");
  if (!fourEdgesZero) pseudoFailures.push("inset");
  if (pseudo?.opacity !== "1") pseudoFailures.push("opacity");
  if (pseudo?.pointerEvents !== "none") pseudoFailures.push("pointerEvents");
  if (spotlight.zIndex !== "0") pseudoFailures.push("zIndex");
  if (typeof spotlight.backgroundImage !== "string" || !/radial-gradient\(/i.test(spotlight.backgroundImage)) {
    pseudoFailures.push("backgroundImage");
  }
  if (typeof spotlight.maskImage !== "string" || spotlight.maskImage === "" || spotlight.maskImage === "none") {
    pseudoFailures.push("maskImage");
  }
  if (typeof pseudo?.maskSize !== "string" || pseudo.maskSize === "") pseudoFailures.push("maskSize");
  if (typeof pseudo?.maskRepeat !== "string" || pseudo.maskRepeat === "") {
    pseudoFailures.push("maskRepeat");
  }
  if (pseudoFailures.length > 0) {
    return { status: "rejected", reason: `spotlight-pseudo-unproven:${pseudoFailures.join(",")}` };
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    typeof spotlight.mask !== "string" ||
    spotlight.mask === "" ||
    spotlight.mask === "none"
  ) {
    return { status: "rejected", reason: "spotlight-variables-unproven" };
  }
  if (!headingLeads || !labelsLead) {
    return { status: "rejected", reason: "spotlight-labels-unproven" };
  }
  if (
    !noExtraStacking(stack?.fill) ||
    !noExtraStacking(stack?.track) ||
    !noExtraStacking(stack?.list) ||
    !noExtraStacking(stack?.row)
  ) {
    return { status: "rejected", reason: "spotlight-stack-unproven" };
  }
  return { status: "admitted", reason: "" };
}

function centerStripHitFailure(result, clip, phase, active) {
  if (result?.scope !== EXPECTED_HIT_SCOPE) {
    return `hit-test-scope:${phase}:${String(result?.scope ?? "missing")}`;
  }
  if (
    result.clip?.x !== clip.x ||
    result.clip?.y !== clip.y ||
    result.clip?.width !== clip.width ||
    result.clip?.height !== clip.height
  ) {
    return `hit-test-clip-mismatch:${phase}`;
  }
  if (!Array.isArray(result.points) || result.points.length !== clip.width) {
    return `hit-test-incomplete-strip:${phase}`;
  }
  for (let index = 0; index < clip.width; index += 1) {
    const point = result.points[index];
    if (
      point?.kind !== `pixel-${index}` ||
      point.x !== clip.x + index + 0.5 ||
      point.y !== clip.y + 0.5 ||
      point.integer?.x !== clip.x + index ||
      point.integer?.y !== clip.y
    ) {
      return `hit-test-invalid-point:${phase}:${index}`;
    }
    const nativeAccepted =
      point.native?.exactFill === true || (active === true && point.native?.expectedDetailSpotlight === true);
    if (point.dom?.exactFill !== true || !nativeAccepted) {
      return `hit-test-non-fill:${phase}:${point.kind}`;
    }
  }
  return null;
}

function failureWithEvidence(error, evidence) {
  if (error instanceof Error && Object.isExtensible(error)) {
    error.detailBarCaptureEvidence = evidence;
    return error;
  }
  const failure = new Error("detail bar capture 失败（原始错误保留在 cause）", { cause: error });
  failure.detailBarCaptureEvidence = evidence;
  return failure;
}

function describeThrown(error) {
  return error instanceof Error ? error.message : `thrown:${String(error)}`;
}

export async function captureDetailBarThreeFrames({
  page,
  fill,
  probeHits,
  probeActiveHits = probeDetailBarActiveCenterStripHits,
} = {}) {
  if (!page || typeof page.screenshot !== "function" || typeof page.evaluate !== "function") {
    throw new TypeError("captureDetailBarThreeFrames: 需要可用的 Playwright page");
  }
  if (!fill || typeof fill.evaluate !== "function") {
    throw new TypeError("captureDetailBarThreeFrames: 需要同一个 fill ElementHandle");
  }
  if (probeHits !== undefined && typeof probeHits !== "function") {
    throw new TypeError("captureDetailBarThreeFrames: probeHits 必须是函数");
  }

  const evidence = {
    status: "incomplete",
    reason: "",
    geometry: null,
    plan: null,
    clip: null,
    proof: null,
    spotlightAdmission: null,
    probes: {},
    frames: { normal: null, background: null, verify: null },
    paint: { begin: null, restore: null },
    restoration: { attempted: false, verified: false },
    validatedPixels: false,
    pixelAnalysis: "not-run",
    hitTest: {
      status: "not-run",
      reason: "",
      scope: null,
      phases: {},
    },
    roundedAncestorProof: "not-run",
  };
  let baseline = null;
  let restoreNeeded = false;
  let hasPrimaryError = false;
  let primaryError;
  let hasRestorationError = false;
  let restorationError;
  let restoredRejectReason = null;

  const probe = async (phase) => {
    const result = await fill.evaluate(probeDetailBarGeometry);
    evidence.probes[phase] = result;
    return result;
  };
  const stable = (phase, current) => {
    if (current?.status !== "observed") return `geometry-not-observed:${phase}`;
    if (JSON.stringify(baseline) !== JSON.stringify(current)) return `geometry-drift:${phase}`;
    return null;
  };
  const screenshot = () =>
    screenshotWithStyleAttributeGuard(page, {
      ...SCREENSHOT_OPTIONS,
      clip: { ...evidence.clip },
    });
  const captureFrame = async (name) => {
    const frame = await screenshot();
    if (!Buffer.isBuffer(frame) || frame.length === 0) throw new Error(`invalid-${name}-frame`);
    return frame;
  };
  let selectedProbeHits = probeHits ?? probeDetailBarCenterStripHits;
  let activeHitMode = false;
  const hit = async (phase) => {
    try {
      const result = await selectedProbeHits({ page, fill, clip: { ...evidence.clip } });
      evidence.hitTest.phases[phase] = result;
      evidence.hitTest.scope = typeof result?.scope === "string" ? result.scope : null;
      if (result?.status !== "observed") {
        throw new CaptureRejected(`hit-test-not-observed:${phase}:${result?.reason ?? "missing"}`);
      }
      const hitFailure = centerStripHitFailure(result, evidence.clip, phase, activeHitMode);
      if (hitFailure) throw new CaptureRejected(hitFailure);
      evidence.hitTest.status =
        Object.keys(evidence.hitTest.phases).length === HIT_TEST_PHASES.length ? "observed" : "partial";
    } catch (error) {
      if (!(error instanceof CaptureRejected) && error?.detailBarHitEvidence) {
        evidence.hitTest.phases[phase] = error.detailBarHitEvidence;
      } else if (!Object.hasOwn(evidence.hitTest.phases, phase)) {
        evidence.hitTest.phases[phase] = { status: "threw", reason: describeThrown(error) };
      }
      evidence.hitTest.status = error instanceof CaptureRejected ? "rejected" : "failed";
      evidence.hitTest.reason =
        error instanceof CaptureRejected ? error.message : `hit-test-threw:${phase}:${describeThrown(error)}`;
      throw error;
    }
  };

  try {
    const before = await probe("before");
    evidence.geometry = before;
    if (before?.status !== "observed") {
      throw new CaptureRejected(`geometry-not-observed:${before?.reason ?? "missing"}`);
    }
    const admission = spotlightAdmission(before.spotlight);
    evidence.spotlightAdmission = admission;
    if (admission.status === "rejected") {
      throw new CaptureRejected(`spotlight-admission:${admission.reason}`);
    }
    if (admission.status === "admitted") {
      if (typeof probeActiveHits !== "function") {
        throw new CaptureRejected("active-hit-probe-missing");
      }
      selectedProbeHits = probeActiveHits;
      activeHitMode = true;
    }
    baseline = before;

    const plan = planDetailBarCenterStrip({
      fillRect: before.fillRect,
      visibleRect: before.visibleRect,
      radius: before.radius,
    });
    evidence.plan = plan;
    if (plan?.status !== "measured") {
      throw new CaptureRejected(`center-strip-unmeasured:${plan?.reason ?? "missing"}`);
    }
    const clip = plan.sampleClip;
    if (
      clip?.height !== 1 ||
      !Number.isInteger(clip.x) ||
      !Number.isInteger(clip.y) ||
      !Number.isInteger(clip.width) ||
      clip.width <= 0 ||
      clip.x < 0 ||
      clip.y < 0 ||
      clip.x + clip.width > before.viewport.width ||
      clip.y + clip.height > before.viewport.height
    ) {
      throw new CaptureRejected("invalid-center-strip-clip");
    }
    evidence.clip = clip;
    const sourceShapes = before.clipShapes;
    if (!Array.isArray(sourceShapes) || sourceShapes.length === 0) {
      evidence.proof = { status: "unmeasured", reason: "clip-shapes-missing", shapes: sourceShapes ?? null };
      throw new CaptureRejected("clip-shapes-missing");
    }
    let proof;
    try {
      proof = validateDetailBarClipInsideShapes({ clip, shapes: sourceShapes });
    } catch (error) {
      evidence.proof = {
        status: "unmeasured",
        reason: `clip-shapes-invalid:${describeThrown(error)}`,
        shapes: sourceShapes,
      };
      throw new CaptureRejected("clip-shapes-invalid");
    }
    evidence.proof = { ...proof, shapes: sourceShapes };
    if (proof.status !== "measured") {
      throw new CaptureRejected(`clip-shapes-unproven:${proof.reason || "missing"}`);
    }

    let reason = stable("beforeNormal", await probe("beforeNormal"));
    if (reason) throw new CaptureRejected(reason);
    await hit("beforeNormal");
    evidence.frames.normal = await captureFrame("normal");
    reason = stable("afterNormal", await probe("afterNormal"));
    if (reason) throw new CaptureRejected(reason);
    await hit("afterNormal");

    try {
      evidence.paint.begin = await fill.evaluate(beginDetailBarPaintHide);
    } catch (error) {
      restoreNeeded = true;
      throw error;
    }
    if (evidence.paint.begin?.status !== "hidden") {
      throw new CaptureRejected(`paint-hide-rejected:${evidence.paint.begin?.reason ?? "missing"}`);
    }
    restoreNeeded = true;
    reason = stable("hidden", await probe("hidden"));
    if (reason) throw new CaptureRejected(reason);
    await hit("hidden");
    evidence.frames.background = await captureFrame("background");
    reason = stable("afterBackground", await probe("afterBackground"));
    if (reason) throw new CaptureRejected(reason);
    await hit("afterBackground");
  } catch (error) {
    if (error instanceof CaptureRejected) {
      evidence.status = "rejected";
      evidence.reason = error.message;
    } else {
      hasPrimaryError = true;
      primaryError = error;
    }
  } finally {
    if (restoreNeeded) {
      evidence.restoration.attempted = true;
      try {
        evidence.paint.restore = await fill.evaluate(restoreDetailBarPaintHide);
        if (evidence.paint.restore?.status !== "restored") {
          evidence.restoration.result = evidence.paint.restore ?? null;
          hasRestorationError = true;
          restorationError = new Error(`paint-restore-unverified:${evidence.paint.restore?.status ?? "missing"}`);
        } else {
          const restored = await probe("restored");
          const reason = stable("restored", restored);
          if (reason) restoredRejectReason = reason;
          else evidence.restoration.verified = true;
        }
      } catch (error) {
        hasRestorationError = true;
        restorationError = error;
      }
    }
  }

  if (hasPrimaryError || hasRestorationError) {
    evidence.status = "failed";
    evidence.reason = hasPrimaryError ? describeThrown(primaryError) : describeThrown(restorationError);
    let failure;
    if (hasPrimaryError && hasRestorationError) {
      failure = new AggregateError([primaryError, restorationError], "detail bar capture 失败且恢复失败");
    } else {
      failure = hasPrimaryError ? primaryError : restorationError;
    }
    throw failureWithEvidence(failure, evidence);
  }
  if (evidence.status === "rejected") return evidence;
  if (restoredRejectReason) {
    evidence.status = "rejected";
    evidence.reason = restoredRejectReason;
    return evidence;
  }

  try {
    await hit("restored");
    evidence.frames.verify = await captureFrame("verify");
    const reason = stable("afterVerify", await probe("afterVerify"));
    if (reason) {
      evidence.status = "rejected";
      evidence.reason = reason;
      return evidence;
    }
    await hit("afterVerify");
  } catch (error) {
    if (error instanceof CaptureRejected) {
      evidence.status = "rejected";
      evidence.reason = error.message;
      return evidence;
    }
    throw failureWithEvidence(error, evidence);
  }

  evidence.status = "captured-unvalidated";
  return evidence;
}
