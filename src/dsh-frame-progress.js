const ZSTD_MAGIC = 0xfd2fb528;
const MAX_ZSTD_BLOCK_BYTES = 128 * 1024;

/**
 * @typedef {(offset: number, length: number) => Promise<Buffer> | Buffer} ReadAt
 * @typedef {{ partial: true, reason: string }} PartialFrame
 * @typedef {{
 *   partial: false,
 *   start: number,
 *   end: number,
 *   checksum: boolean,
 *   contentSize: number | bigint | null,
 *   dictionaryId: number,
 *   blockCount: number
 * }} FrameBoundary
 * @typedef {PartialFrame | FrameBoundary} FrameBoundaryResult
 */

export class SourceProgressUnsupportedError extends Error {
  constructor(reason) {
    super(`SOURCE_PROGRESS_UNSUPPORTED: ${reason}`);
    this.name = "SourceProgressUnsupportedError";
    this.code = "SOURCE_PROGRESS_UNSUPPORTED";
  }
}

function unsupported(reason) {
  return new SourceProgressUnsupportedError(reason);
}

/** @returns {PartialFrame} */
function partial(reason) {
  return { partial: true, reason };
}

function uint64WithinSafeInteger(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** @returns {value is Buffer} */
function isBufferResult(value) {
  return Buffer.isBuffer(value);
}

/** @returns {value is PartialFrame} */
function isPartialFrame(value) {
  return value.partial === true;
}

/**
 * @param {ReadAt} readAt
 * @returns {Promise<Buffer | PartialFrame>}
 */
async function readExact(readAt, offset, length, end, reason) {
  if (offset < 0 || length < 0 || offset + length > end) {
    return partial(reason);
  }
  const bytes = await readAt(offset, length);
  if (!Buffer.isBuffer(bytes) || bytes.length !== length) {
    return partial(reason);
  }
  return bytes;
}

/**
 * Read one complete RFC 8878 Zstandard frame from its structural header,
 * block headers, optional checksum, and exact ending offset. Compressed block
 * payloads are skipped during structural scanning and read later as one frame.
 * @param {ReadAt} readAt
 * @returns {Promise<FrameBoundaryResult>}
 */
export async function readZstdFrameBoundary(readAt, start, end) {
  const magic = await readExact(readAt, start, 4, end, "partial zstd magic");
  if (!isBufferResult(magic)) return magic;
  if (magic.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw unsupported(`unsupported zstd structure at byte ${start}`);
  }

  const descriptorBytes = await readExact(readAt, start + 4, 1, end, "partial zstd frame header");
  if (!isBufferResult(descriptorBytes)) return descriptorBytes;
  const descriptor = descriptorBytes[0];
  if (descriptor & 0x08) {
    throw unsupported("reserved zstd frame-header bit is set");
  }

  const fcsFlag = descriptor >> 6;
  const singleSegment = Boolean(descriptor & 0x20);
  const checksum = Boolean(descriptor & 0x04);
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag];
  const contentSizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  const fixedHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  let at = start + 5;

  const fixedHeader =
    fixedHeaderBytes === 0
      ? Buffer.alloc(0)
      : await readExact(readAt, at, fixedHeaderBytes, end, "partial zstd frame descriptor fields");
  if (!isBufferResult(fixedHeader)) return fixedHeader;

  let fixedOffset = 0;
  if (!singleSegment) {
    at += 1;
    fixedOffset += 1;
  }

  let dictionaryId = 0;
  if (dictionaryBytes) {
    dictionaryId =
      dictionaryBytes === 1
        ? fixedHeader[fixedOffset]
        : dictionaryBytes === 2
          ? fixedHeader.readUInt16LE(fixedOffset)
          : fixedHeader.readUInt32LE(fixedOffset);
  }
  if (dictionaryId !== 0) {
    throw unsupported(`zstd dictionary ${dictionaryId} is not supported`);
  }
  at += dictionaryBytes;
  fixedOffset += dictionaryBytes;

  /** @type {number | bigint | null} */
  let contentSize = null;
  if (contentSizeBytes === 1) {
    contentSize = fixedHeader[fixedOffset];
  } else if (contentSizeBytes === 2) {
    contentSize = fixedHeader.readUInt16LE(fixedOffset) + 256;
  } else if (contentSizeBytes === 4) {
    contentSize = fixedHeader.readUInt32LE(fixedOffset);
  } else if (contentSizeBytes === 8) {
    contentSize = uint64WithinSafeInteger(fixedHeader, fixedOffset);
  }
  at += contentSizeBytes;

  let blockCount = 0;
  while (true) {
    const blockHeaderBytes = await readExact(readAt, at, 3, end, "partial zstd block header");
    if (!isBufferResult(blockHeaderBytes)) return blockHeaderBytes;
    const blockHeader = blockHeaderBytes.readUIntLE(0, 3);
    at += 3;
    const lastBlock = Boolean(blockHeader & 0x01);
    const blockType = (blockHeader >> 1) & 0x03;
    const blockSize = blockHeader >> 3;
    if (blockType === 3) {
      throw unsupported("reserved zstd block type");
    }
    if (blockSize > MAX_ZSTD_BLOCK_BYTES) {
      throw unsupported(`zstd block size ${blockSize} exceeds the format limit`);
    }
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (at + payloadBytes > end) {
      return partial("partial zstd block payload");
    }
    at += payloadBytes;
    blockCount += 1;
    if (lastBlock) {
      break;
    }
  }

  if (checksum) {
    if (at + 4 > end) {
      return partial("partial zstd checksum");
    }
    at += 4;
  }

  return {
    partial: false,
    start,
    end: at,
    checksum,
    contentSize,
    dictionaryId,
    blockCount,
  };
}

/**
 * Yield one bounded compressed frame at a time. The caller owns the yielded
 * buffer only for the current iteration; no suffix or descriptor array is retained.
 * @param {ReadAt} readAt
 * @param {{ maxFrameBytes?: number }} [options]
 * @returns {AsyncGenerator<{ boundary: FrameBoundary, compressed: Buffer }>}
 */
export async function* readZstdFrames(readAt, start, end, options = {}) {
  const { maxFrameBytes } = options;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw unsupported("invalid compressed byte range");
  }
  let offset = start;
  while (offset < end) {
    const boundary = await readZstdFrameBoundary(readAt, offset, end);
    if (isPartialFrame(boundary)) {
      throw unsupported(boundary.reason);
    }
    const compressedBytes = boundary.end - offset;
    if (maxFrameBytes !== undefined && (!Number.isSafeInteger(maxFrameBytes) || compressedBytes > maxFrameBytes)) {
      throw unsupported(`compressed frame size ${compressedBytes} exceeds the bounded input`);
    }
    const compressed = await readExact(readAt, offset, compressedBytes, end, "partial zstd frame payload");
    if (!isBufferResult(compressed)) {
      throw unsupported(compressed.reason);
    }
    yield { boundary, compressed };
    offset = boundary.end;
  }
}
