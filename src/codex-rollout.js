import { createReadStream } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";

/** @param {AsyncIterable<Buffer>} source @param {(chunk: Buffer) => unknown} onChunk */
async function decodeVerifiedZstd(source, onChunk) {
  // Node 23/24 can silently accept truncated frames and stop after the first frame.
  const iterator = source[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0),
    at = 0,
    frames = 0;
  async function take(size, allowEnd = false) {
    if (!size) return Buffer.alloc(0);
    const parts = [];
    let left = size;
    while (left) {
      if (at === chunk.length) {
        const next = await iterator.next();
        if (next.done) {
          if (allowEnd && left === size) return null;
          throw new Error("TRUNCATED_FRAME");
        }
        chunk = next.value;
        at = 0;
        if (!chunk.length) continue;
      }
      const n = Math.min(left, chunk.length - at);
      parts.push(chunk.subarray(at, at + n));
      at += n;
      left -= n;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }
  try {
    while (true) {
      const magicBytes = await take(4, true);
      if (magicBytes === null) break;
      const magic = magicBytes.readUInt32LE();
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        let size = (await take(4)).readUInt32LE();
        while (size) {
          const n = Math.min(size, 65536);
          await take(n);
          size -= n;
        }
        frames++;
        continue;
      }
      if (magic !== 0xfd2fb528) throw new Error("UNKNOWN_FRAME_OR_TRAILING_BYTES");
      const descriptorBytes = await take(1),
        descriptor = descriptorBytes[0];
      if (descriptor & 8) throw new Error("RESERVED_HEADER_BIT");
      const singleSegment = Boolean(descriptor & 32),
        headers = [magicBytes, descriptorBytes];
      let window = Infinity;
      if (!singleSegment) {
        const wd = await take(1);
        headers.push(wd);
        const base = 2 ** (10 + (wd[0] >> 3));
        window = base + (base / 8) * (wd[0] & 7);
      }
      const dictionary = await take([0, 1, 2, 4][descriptor & 3]);
      headers.push(dictionary);
      const sizeField = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
      const sizeBytes = await take(sizeField);
      headers.push(sizeBytes);
      let expectedSize = null;
      if (sizeField === 8) {
        const big = sizeBytes.readBigUInt64LE();
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("UNSUPPORTED_CONTENT_SIZE");
        expectedSize = Number(big);
      } else if (sizeField) expectedSize = sizeBytes.readUIntLE(0, sizeField) + (sizeField === 2 ? 256 : 0);
      if (singleSegment) window = expectedSize;
      const maximumBlockSize = Math.min(window, 131072);
      let frameOutput = 0,
        frameInput = 0;
      async function* frameChunks() {
        for (const header of headers) {
          frameInput += header.length;
          if (header.length) yield header;
        }
        let last = false;
        while (!last) {
          const header = await take(3),
            value = header.readUIntLE(0, 3);
          last = Boolean(value & 1);
          const kind = (value >> 1) & 3,
            size = value >>> 3;
          if (kind === 3) throw new Error("RESERVED_BLOCK_TYPE");
          if (size > maximumBlockSize) throw new Error("OVERSIZED_BLOCK");
          frameInput += header.length;
          yield header;
          const body = await take(kind === 1 ? 1 : size);
          frameInput += body.length;
          if (body.length) yield body;
        }
        if (descriptor & 4) {
          const crc = await take(4);
          frameInput += crc.length;
          yield crc;
        }
      }
      const decoder = createZstdDecompress();
      await pipeline(
        Readable.from(frameChunks()),
        decoder,
        new Writable({
          write(bytes, _encoding, done) {
            frameOutput += bytes.length;
            Promise.resolve()
              .then(() => onChunk(bytes))
              .then(() => done(), done);
          },
        }),
      );
      if (decoder.bytesWritten !== frameInput) throw new Error("UNCONSUMED_FRAME_BYTES");
      if (expectedSize !== null && frameOutput !== expectedSize) throw new Error("CONTENT_SIZE_MISMATCH");
      frames++;
    }
    if (!frames) throw new Error("EMPTY_COMPRESSED_INPUT");
  } finally {
    await iterator.return?.(undefined);
  }
}

export function plainRolloutPath(filePath) {
  return filePath.endsWith(".jsonl.zst") ? filePath.slice(0, -4) : filePath;
}

export function openRolloutStream(filePath) {
  if (!filePath.endsWith(".jsonl.zst")) return createReadStream(filePath, { encoding: "utf8" });
  const source = createReadStream(filePath);
  const output = new PassThrough();
  const text = new TextDecoder("utf-8", { fatal: true });
  output.on("close", () => source.destroy());
  void decodeVerifiedZstd(
    source,
    (chunk) =>
      new Promise((resolve, reject) => {
        const decoded = text.decode(chunk, { stream: true });
        output.write(decoded, (error) => (error ? reject(error) : resolve(undefined)));
      }),
  )
    .then(() => output.end(text.decode()))
    .catch((error) => output.destroy(error));
  return output;
}

export async function* readRolloutLines(filePath) {
  const input = openRolloutStream(filePath).setEncoding("utf8");
  let fragments = [];
  try {
    for await (const chunk of input) {
      let from = 0;
      let end = chunk.indexOf("\n");
      // JSON allows U+2028/U+2029 inside strings; readline splits those into false records.
      while (end !== -1) {
        fragments.push(chunk.slice(from, end));
        yield fragments.join("");
        fragments = [];
        from = end + 1;
        end = chunk.indexOf("\n", from);
      }
      if (from < chunk.length) fragments.push(chunk.slice(from));
    }
    if (fragments.length) yield fragments.join("");
  } finally {
    input.destroy();
  }
}
