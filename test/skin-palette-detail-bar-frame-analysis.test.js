import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  analyzeDetailBarFrames,
  decodeDetailBarFramesInPage,
} from "../scripts/skin-palette/detail-bar-frame-analysis.mjs";

function pixelBuffer(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(fill(index % width, Math.floor(index / width)), index * 4);
  }
  return data;
}

function createVmPage({ images, canvasErrorAt = -1 }) {
  let imageIndex = 0;
  const specs = images.map((image) => ({
    ...image,
    data: pixelBuffer(image.width, image.height, image.fill),
  }));

  class StubImage {
    constructor() {
      this.spec = specs[Math.min(imageIndex, specs.length - 1)];
      this.index = imageIndex;
      imageIndex += 1;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }

    set src(value) {
      this.source = value;
      if (this.spec.error) this.onerror();
      else this.onload();
    }

    async decode() {
      if (this.spec.decodeError) throw new Error(this.spec.decodeError);
      this.naturalWidth = this.spec.width;
      this.naturalHeight = this.spec.height;
    }
  }

  class StubCanvas {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.data = null;
      this.index = imageIndex - 1;
    }

    getContext() {
      if (this.index === canvasErrorAt) throw new Error(`canvas-${this.index} boom`);
      const canvas = this;
      return {
        drawImage(image) {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.data = image.spec.data;
        },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let row = 0; row < height; row += 1) {
            const start = ((y + row) * canvas.width + x) * 4;
            data.set(canvas.data.subarray(start, start + width * 4), row * width * 4);
          }
          return { data };
        },
      };
    }
  }

  let evaluateCalls = 0;
  return {
    get evaluateCalls() {
      return evaluateCalls;
    },
    page: {
      async evaluate(fn, argument) {
        evaluateCalls += 1;
        const context = vm.createContext({
          Image: StubImage,
          document: { createElement: () => new StubCanvas() },
        });
        const isolated = vm.runInNewContext(`(${fn.toString()})`, context);
        return JSON.parse(JSON.stringify(await isolated(argument)));
      },
    },
  };
}

function frame(width, height, rgba) {
  return {
    width,
    height,
    fill: typeof rgba === "function" ? rgba : () => rgba,
  };
}

const FRAMES = {
  normal: Buffer.from("normal"),
  background: Buffer.from("background"),
  verify: Buffer.from("verify"),
};

test("clip 与三帧合同严格，失败前不调用 evaluate", async () => {
  const fixture = createVmPage({ images: [frame(1, 1, [0, 0, 0, 255])] });
  await assert.rejects(
    analyzeDetailBarFrames({ page: fixture.page, clip: { x: 0, y: 0, width: 0, height: 1 }, frames: FRAMES }),
    TypeError,
  );
  await assert.rejects(
    analyzeDetailBarFrames({ page: fixture.page, clip: { x: 0, y: 0, width: 1, height: 2 }, frames: FRAMES }),
    TypeError,
  );
  await assert.rejects(
    analyzeDetailBarFrames({
      page: fixture.page,
      clip: { x: 0, y: 0, width: 1, height: 1 },
      frames: { ...FRAMES, verify: Buffer.alloc(0) },
    }),
    TypeError,
  );
  await assert.rejects(
    analyzeDetailBarFrames({
      page: fixture.page,
      clip: { x: 0, y: 0, width: 1, height: 1 },
      frames: { ...FRAMES, background: new Uint8Array([1]) },
    }),
    TypeError,
  );
  assert.equal(fixture.evaluateCalls, 0);
});

test("三图解码尺寸必须等于 clip，否则 unmeasured", async () => {
  const fixture = createVmPage({
    images: [frame(4, 1, [0, 0, 0, 255]), frame(3, 1, [255, 255, 255, 255]), frame(4, 1, [0, 0, 0, 255])],
  });
  const result = await analyzeDetailBarFrames({
    page: fixture.page,
    clip: { x: 5, y: 7, width: 4, height: 1 },
    frames: FRAMES,
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /background.*3×1.*clip 4×1/);
  assert.equal(result.worstRatio, null);
  assert.deepEqual(result.dimensions.background, { width: 3, height: 1 });
});

test("image.onerror 与 canvas 异常均明确失败", async () => {
  const badImage = createVmPage({
    images: [
      frame(1, 1, [0, 0, 0, 255]),
      { ...frame(1, 1, [255, 255, 255, 255]), error: true },
      frame(1, 1, [0, 0, 0, 255]),
    ],
  });
  await assert.rejects(
    analyzeDetailBarFrames({
      page: badImage.page,
      clip: { x: 0, y: 0, width: 1, height: 1 },
      frames: FRAMES,
    }),
    /background.*image\.onerror/,
  );

  const badCanvas = createVmPage({
    images: [frame(1, 1, [0, 0, 0, 255]), frame(1, 1, [255, 255, 255, 255]), frame(1, 1, [0, 0, 0, 255])],
    canvasErrorAt: 1,
  });
  await assert.rejects(
    analyzeDetailBarFrames({
      page: badCanvas.page,
      clip: { x: 0, y: 0, width: 1, height: 1 },
      frames: FRAMES,
    }),
    /background.*canvas.*boom/,
  );
});

test("normal 与 verify 任一 RGBA 通道不同即 unmeasured，并保留首差位置", async () => {
  const fixture = createVmPage({
    images: [
      frame(2, 1, (x) => (x === 0 ? [10, 20, 30, 255] : [40, 50, 60, 255])),
      frame(2, 1, [255, 255, 255, 255]),
      frame(2, 1, (x) => (x === 0 ? [10, 20, 30, 254] : [40, 50, 60, 255])),
    ],
  });
  const result = await analyzeDetailBarFrames({
    page: fixture.page,
    clip: { x: 9, y: 4, width: 2, height: 1 },
    frames: FRAMES,
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /逐 RGBA 不一致/);
  assert.equal(result.worstRatio, null);
  assert.equal(result.restoration.differingPixels, 1);
  assert.deepEqual(result.restoration.firstDifference, {
    x: 0,
    y: 0,
    channel: 3,
    normal: 255,
    verify: 254,
  });
});

test("alpha 由现有 C2 分析器整条拒绝", async () => {
  const fixture = createVmPage({
    images: [
      frame(3, 1, (x) => (x === 1 ? [0, 0, 0, 254] : [0, 0, 0, 255])),
      frame(3, 1, [255, 255, 255, 255]),
      frame(3, 1, (x) => (x === 1 ? [0, 0, 0, 254] : [0, 0, 0, 255])),
    ],
  });
  const result = await analyzeDetailBarFrames({
    page: fixture.page,
    clip: { x: 2, y: 3, width: 3, height: 1 },
    frames: FRAMES,
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /foreground 在 x=1 的 alpha 为 254/);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.worstRatio, null);
  assert.equal(result.restoration.identical, true);
  assert.deepEqual(result.sampleRange, { x: 2, y: 3, width: 3, height: 1 });
});

test("已知黑白两色返回真实 21:1 与采样范围，不附带 PASS/FAIL", async () => {
  const fixture = createVmPage({
    images: [frame(3, 1, [0, 0, 0, 255]), frame(3, 1, [255, 255, 255, 255]), frame(3, 1, [0, 0, 0, 255])],
  });
  const result = await analyzeDetailBarFrames({
    page: fixture.page,
    clip: { x: 5, y: 7, width: 3, height: 1 },
    frames: FRAMES,
  });
  assert.equal(result.status, "measured");
  assert.equal(result.worstRatio, 21);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.worst.x, 0);
  assert.deepEqual(result.sampleRange, { x: 5, y: 7, width: 3, height: 1 });
  assert.equal(result.restoration.differingPixels, 0);
  assert.equal(Object.hasOwn(result, "pass"), false);
  assert.equal(Object.hasOwn(result, "fail"), false);
  assert.equal(typeof decodeDetailBarFramesInPage, "function");
});
