import { analyzeDetailBarPixels } from "./detail-bar-pixels.mjs";

/**
 * Detail bar 三帧像素分析适配器（M5.2.P-B41）。
 *
 * 只解码同一 clip 的 normal/background/verify PNG，核验恢复态后调用
 * C2 的两带分析。返回 measured/unmeasured 与原始比值，不判 PASS/FAIL。
 *
 * shortcut: 只证明调用方给出的 1px 中心采样条；不证明整条、圆角端面或遮挡。
 */

function unmeasured(reason, clip, restoration, dimensions) {
  return {
    status: "unmeasured",
    reason,
    sampleRange: { ...clip },
    sampleCount: 0,
    worstRatio: null,
    worst: null,
    restoration,
    dimensions,
  };
}

function requireClip(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("clip 必须是 { x, y, width, height } 对象");
  }
  for (const name of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(value[name])) {
      throw new TypeError(`clip.${name} 必须是安全整数（收到 ${String(value[name])}）`);
    }
  }
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height !== 1) {
    throw new TypeError(
      `clip 必须是非负坐标、正宽度且 height=1（收到 x=${value.x}, y=${value.y}, width=${value.width}, height=${value.height}）`,
    );
  }
  return { x: value.x, y: value.y, width: value.width, height: 1 };
}

function requireFrames(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("frames 必须是 { normal, background, verify } 对象");
  }
  const frames = {};
  for (const name of ["normal", "background", "verify"]) {
    const frame = value[name];
    if (!Buffer.isBuffer(frame) || frame.length === 0) {
      throw new TypeError(`frames.${name} 必须是非空 Buffer`);
    }
    frames[name] = frame;
  }
  return frames;
}

function readDecodedFrame(value, name) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name} 帧解码结果不是对象`);
  }
  if (
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width <= 0 ||
    value.height <= 0 ||
    !Array.isArray(value.data)
  ) {
    throw new Error(`${name} 帧解码结果缺少有效尺寸或 RGBA 数组`);
  }
  if (value.data.length !== value.width * value.height * 4) {
    throw new Error(`${name} 帧 RGBA 长度与解码尺寸不匹配`);
  }
  return { width: value.width, height: value.height, data: value.data };
}

function compareRgba(normal, verify) {
  if (normal.length !== verify.length) {
    throw new Error("normal 与 verify 的 RGBA 长度不一致");
  }
  let differingPixels = 0;
  let firstDifference = null;
  for (let offset = 0; offset < normal.length; offset += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      const before = normal[offset + channel];
      const after = verify[offset + channel];
      if (before === after) continue;
      differingPixels += 1;
      if (!firstDifference) {
        const pixel = offset / 4;
        firstDifference = {
          x: pixel,
          y: 0,
          channel,
          normal: before,
          verify: after,
        };
      }
      break;
    }
  }
  return { identical: differingPixels === 0, differingPixels, firstDifference };
}

/**
 * 导出仅用于 VM 测试在浏览器替身中执行同一 evaluate 函数；集成入口仍只有
 * analyzeDetailBarFrames。
 */
export async function decodeDetailBarFramesInPage(frames) {
  const decode = async (name, base64) => {
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`${name} PNG image.onerror`));
        image.src = `data:image/png;base64,${base64}`;
      });
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error(`${name} canvas getContext 返回空值`);
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(data),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${name} 帧 PNG 解码或 canvas 读取失败：${detail}`, { cause: error });
    }
  };

  return {
    normal: await decode("normal", frames.normal),
    background: await decode("background", frames.background),
    verify: await decode("verify", frames.verify),
  };
}

export async function analyzeDetailBarFrames({ page, clip: rawClip, frames: rawFrames } = {}) {
  if (!page || typeof page.evaluate !== "function") {
    throw new TypeError("analyzeDetailBarFrames: 需要带 evaluate 的 page");
  }
  const clip = requireClip(rawClip);
  const frames = requireFrames(rawFrames);
  const decoded = await page.evaluate(decodeDetailBarFramesInPage, {
    normal: frames.normal.toString("base64"),
    background: frames.background.toString("base64"),
    verify: frames.verify.toString("base64"),
  });
  const normal = readDecodedFrame(decoded?.normal, "normal");
  const background = readDecodedFrame(decoded?.background, "background");
  const verify = readDecodedFrame(decoded?.verify, "verify");
  const dimensions = {
    normal: { width: normal.width, height: normal.height },
    background: { width: background.width, height: background.height },
    verify: { width: verify.width, height: verify.height },
  };

  for (const [name, frame] of Object.entries({ normal, background, verify })) {
    if (frame.width !== clip.width || frame.height !== clip.height) {
      return unmeasured(
        `${name} 帧尺寸 ${frame.width}×${frame.height} 与 clip ${clip.width}×${clip.height} 不匹配`,
        clip,
        { identical: false, differingPixels: null, firstDifference: null },
        dimensions,
      );
    }
  }

  const restoration = compareRgba(normal.data, verify.data);
  if (!restoration.identical) {
    return unmeasured(
      `normal 与 verify 的逐 RGBA 不一致：differingPixels=${restoration.differingPixels}`,
      clip,
      restoration,
      dimensions,
    );
  }

  const analysis = analyzeDetailBarPixels({
    foreground: { width: clip.width, height: 1, pixels: normal.data },
    background: { width: clip.width, height: 1, pixels: background.data },
  });
  return {
    status: analysis.status,
    reason: analysis.reason,
    sampleRange: { ...clip },
    sampleCount: analysis.sampleCount,
    worstRatio: analysis.worstRatio,
    worst: analysis.worst,
    restoration,
    dimensions,
  };
}
