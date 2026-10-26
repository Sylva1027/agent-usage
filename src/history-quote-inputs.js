const CHUNK_ROWS = 16_384;
const NUMBER_COLUMNS = 7;
const STRING_COLUMNS = 7;
const ROW_BYTES = NUMBER_COLUMNS * 8 + STRING_COLUMNS * 4 + 2;
export const HISTORY_QUOTE_INPUT_MAX_BYTES = 128 * 1024 * 1024;

export class HistoryQuoteInputs {
  constructor(maxBytes = HISTORY_QUOTE_INPUT_MAX_BYTES) {
    this.maxBytes = Math.min(maxBytes, HISTORY_QUOTE_INPUT_MAX_BYTES);
    this.bytes = 1024;
    this.length = 0;
    this.chunks = [];
    this.values = [];
    this.ids = new Map();
    this.active = this.bytes <= this.maxBytes;
    this.complete = false;
  }

  discard() {
    this.active = false;
    this.chunks = [];
    this.values = [];
    this.ids?.clear();
    this.bytes = 0;
    this.length = 0;
  }

  intern(value) {
    if (!this.active) return 0;
    const found = this.ids.get(value);
    if (found !== undefined) return found;
    if (value !== null && value !== undefined && typeof value !== "string") {
      this.discard();
      return 0;
    }
    const bytes = 256 + (typeof value === "string" ? value.length * 4 : 0);
    if (this.bytes + bytes > this.maxBytes) {
      this.discard();
      return 0;
    }
    const id = this.values.length;
    this.values.push(value);
    this.ids.set(value, id);
    this.bytes += bytes;
    return id;
  }

  append(event, bucketKey) {
    if (!this.active) return;
    if (this.complete) throw new Error("Quote inputs are already complete");
    if (
      !Number.isInteger(event.detailMask) ||
      event.detailMask < 0 ||
      event.detailMask > 255 ||
      typeof event.cacheWriteKnown !== "boolean" ||
      typeof event.timestamp !== "number" ||
      typeof event.cacheWriteTokens !== "number" ||
      typeof event.requestInputTokens !== "number" ||
      typeof event.total?.total !== "number" ||
      typeof event.total.input !== "number" ||
      typeof event.total.cached !== "number" ||
      typeof event.total.output !== "number" ||
      typeof bucketKey !== "string"
    ) {
      this.discard();
      return;
    }
    const model = this.intern(event.model);
    const channel = this.intern(event.channel);
    const sourceKind = this.intern(event.sourceKind);
    const contextLevel = this.intern(event.contextLevel);
    const serviceTier = this.intern(event.serviceTier);
    const ttl = this.intern(event.cacheWriteTtl);
    const bucket = this.intern(bucketKey);
    if (!this.active) return;
    const row = this.length % CHUNK_ROWS;
    if (row === 0) {
      const size = CHUNK_ROWS * ROW_BYTES;
      if (this.bytes + size + 256 > this.maxBytes) {
        this.discard();
        return;
      }
      const data = new ArrayBuffer(size);
      this.chunks.push({
        numbers: new Float64Array(data, 0, CHUNK_ROWS * NUMBER_COLUMNS),
        ids: new Uint32Array(data, CHUNK_ROWS * NUMBER_COLUMNS * 8, CHUNK_ROWS * STRING_COLUMNS),
        flags: new Uint16Array(data, CHUNK_ROWS * (NUMBER_COLUMNS * 8 + STRING_COLUMNS * 4), CHUNK_ROWS),
      });
      this.bytes += size + 256;
    }
    const chunk = this.chunks[this.chunks.length - 1];
    const number = row * NUMBER_COLUMNS;
    chunk.numbers[number] = event.timestamp;
    chunk.numbers[number + 1] = event.cacheWriteTokens;
    chunk.numbers[number + 2] = event.requestInputTokens;
    chunk.numbers[number + 3] = event.total.total;
    chunk.numbers[number + 4] = event.total.input;
    chunk.numbers[number + 5] = event.total.cached;
    chunk.numbers[number + 6] = event.total.output;
    const string = row * STRING_COLUMNS;
    chunk.ids[string] = model;
    chunk.ids[string + 1] = channel;
    chunk.ids[string + 2] = sourceKind;
    chunk.ids[string + 3] = contextLevel;
    chunk.ids[string + 4] = serviceTier;
    chunk.ids[string + 5] = ttl;
    chunk.ids[string + 6] = bucket;
    chunk.flags[row] = event.detailMask | (event.cacheWriteKnown ? 256 : 0);
    this.length += 1;
  }

  finish() {
    if (!this.active) return null;
    this.complete = true;
    this.ids.clear();
    return this;
  }

  *events() {
    if (!this.complete || !this.active) throw new Error("Quote inputs are not complete");
    // Only the synchronous pricing consumer sees this reusable event; facts stay in the existing projection.
    const event = {
      timestamp: 0,
      cacheWriteTokens: 0,
      requestInputTokens: 0,
      total: { total: 0, input: 0, cached: 0, output: 0 },
      model: undefined,
      channel: undefined,
      sourceKind: undefined,
      contextLevel: undefined,
      serviceTier: undefined,
      cacheWriteTtl: undefined,
      quoteBucketKey: "",
      detailMask: 0,
      cacheWriteKnown: false,
    };
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const count = Math.min(CHUNK_ROWS, this.length - index * CHUNK_ROWS);
      for (let row = 0; row < count; row += 1) {
        const number = row * NUMBER_COLUMNS;
        event.timestamp = chunk.numbers[number];
        event.cacheWriteTokens = chunk.numbers[number + 1];
        event.requestInputTokens = chunk.numbers[number + 2];
        event.total.total = chunk.numbers[number + 3];
        event.total.input = chunk.numbers[number + 4];
        event.total.cached = chunk.numbers[number + 5];
        event.total.output = chunk.numbers[number + 6];
        const string = row * STRING_COLUMNS;
        event.model = this.values[chunk.ids[string]];
        event.channel = this.values[chunk.ids[string + 1]];
        event.sourceKind = this.values[chunk.ids[string + 2]];
        event.contextLevel = this.values[chunk.ids[string + 3]];
        event.serviceTier = this.values[chunk.ids[string + 4]];
        event.cacheWriteTtl = this.values[chunk.ids[string + 5]];
        event.quoteBucketKey = this.values[chunk.ids[string + 6]];
        event.detailMask = chunk.flags[row] & 255;
        event.cacheWriteKnown = Boolean(chunk.flags[row] & 256);
        yield event;
      }
    }
  }
}
