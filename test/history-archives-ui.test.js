import assert from "node:assert/strict";
import test from "node:test";

import {
  handleHistoryArchiveDayToggle,
  handleHistoryArchiveNextPage,
  handleHistoryArchiveToggle,
  historyArchiveBands,
  refreshHistoryArchives,
  renderHistoryArchivesHtml,
  rerenderHistoryArchives,
} from "../public/history-archives-ui.js";
import { formatLocalDateTime, setLocale } from "../public/i18n.js";

const FIRST_START_MS = Date.parse("2026-10-02T03:04:05.000Z");
const SECOND_START_MS = Date.parse("2026-10-03T04:05:06.000Z");

test("present archives render their range and registered counts with existence-only wording", () => {
  const html = renderHistoryArchivesHtml(
    {
      authority: { formatVersion: 1, segmentIds: ["present"] },
      segments: [
        {
          segmentId: "present",
          startMs: FIRST_START_MS,
          endMs: FIRST_START_MS + 60_000,
          eventCount: 123,
          status: "present",
        },
      ],
      counts: { segments: 1, events: 123 },
    },
    { locale: "en-US" },
  );

  assert.match(html, /Archive segment 1/);
  assert.match(html, /Registered archive segments: 1/);
  assert.match(html, /Registered events: 123/);
  assert.match(html, /Registered \(file existence only; contents not verified\)/);
  assert.ok(html.includes(formatLocalDateTime(FIRST_START_MS, "en-US")));
  assert.doesNotMatch(html, /File missing|File unreadable/);
});

test("missing and unreadable archives keep their ranges and never appear verified", () => {
  const html = renderHistoryArchivesHtml(
    {
      authority: null,
      segments: [
        {
          segmentId: "missing",
          startMs: FIRST_START_MS,
          endMs: FIRST_START_MS + 60_000,
          eventCount: 10,
          status: "missing",
        },
        {
          segmentId: "unreadable",
          startMs: SECOND_START_MS,
          endMs: SECOND_START_MS + 60_000,
          eventCount: 20,
          status: "unreadable",
        },
      ],
      counts: { segments: 2, events: 30 },
    },
    { locale: "en-US" },
  );

  assert.match(html, /File missing \(range retained; event count unavailable\)/);
  assert.match(html, /File unreadable \(range retained; event count unavailable\)/);
  assert.ok(html.includes(formatLocalDateTime(FIRST_START_MS, "en-US")));
  assert.ok(html.includes(formatLocalDateTime(SECOND_START_MS, "en-US")));
  assert.match(html, /Registered events: 30/);
  assert.doesNotMatch(html, /Registered events: 10|Registered events: 20/);
  assert.doesNotMatch(html, /Registered \(file existence only|verified/i);
});

test("adjacent segments form local-year bands while gaps, year changes, and invalid ranges stay separate", () => {
  const segments = [
    {
      segmentId: "jan",
      startMs: Date.parse("2025-01-10T04:00:00.000Z"),
      endMs: Date.parse("2025-01-20T04:00:00.000Z"),
      eventCount: 10,
      status: "present",
    },
    {
      segmentId: "feb",
      startMs: Date.parse("2025-01-20T04:00:00.000Z"),
      endMs: Date.parse("2025-02-10T04:00:00.000Z"),
      eventCount: 20,
      status: "missing",
    },
    {
      segmentId: "gap",
      startMs: Date.parse("2025-03-01T04:00:00.000Z"),
      endMs: Date.parse("2025-03-10T04:00:00.000Z"),
      eventCount: 30,
      status: "present",
    },
    {
      segmentId: "overlap",
      startMs: Date.parse("2025-03-05T04:00:00.000Z"),
      endMs: Date.parse("2025-03-15T04:00:00.000Z"),
      eventCount: 35,
      status: "present",
    },
    {
      segmentId: "next-year",
      startMs: Date.parse("2026-01-10T04:00:00.000Z"),
      endMs: Date.parse("2026-01-20T04:00:00.000Z"),
      eventCount: 40,
      status: "present",
    },
    {
      segmentId: "cross-year",
      startMs: Date.parse("2026-12-20T04:00:00.000Z"),
      endMs: Date.parse("2027-01-10T04:00:00.000Z"),
      eventCount: 50,
      status: "present",
    },
    {
      segmentId: "invalid",
      startMs: Date.parse("2026-12-20T04:00:00.000Z"),
      endMs: Date.parse("2026-12-19T04:00:00.000Z"),
      eventCount: 60,
      status: "present",
    },
    {
      segmentId: "unrepresentable",
      startMs: 9_000_000_000_000_000,
      endMs: 9_000_000_000_000_001,
      eventCount: 70,
      status: "present",
    },
  ];
  const bands = historyArchiveBands(segments);
  assert.deepEqual(
    bands.map((band) => ({
      year: band.year,
      segmentIds: band.segments.map((segment) => segment.segmentId),
    })),
    [
      { year: 2025, segmentIds: ["jan", "feb"] },
      { year: 2025, segmentIds: ["gap"] },
      { year: 2025, segmentIds: ["overlap"] },
      { year: 2026, segmentIds: ["next-year"] },
      { year: null, segmentIds: ["cross-year"] },
      { year: null, segmentIds: ["invalid"] },
      { year: null, segmentIds: ["unrepresentable"] },
    ],
  );

  const html = renderHistoryArchivesHtml({ segments, counts: { segments: 8, events: 315 } }, { locale: "en-US" });
  assert.equal((html.match(/data-archive-band-year=/g) || []).length, 7);
  assert.match(html, /2025 Archive band/);
  assert.match(html, /2026 Archive band/);
  assert.match(html, /Archive band/);
  assert.match(html, /Archive segment 2/);
  assert.match(html, /File missing \(range retained; event count unavailable\)/);
  assert.ok(html.includes(formatLocalDateTime(segments[1].startMs, "en-US")));
  assert.doesNotMatch(html, /Registered events: 20|Event count: 0/);
});

test("fetch failures render an explicit error without fake zero counts", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  try {
    await refreshHistoryArchives({
      container,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "archive service offline" }),
      }),
    });
    assert.match(container.innerHTML, /Archive status unavailable: archive service offline/);
    assert.doesNotMatch(container.innerHTML, /Registered archive segments: 0|Registered events: 0/);

    await refreshHistoryArchives({
      container,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    assert.match(container.innerHTML, /Archive status unavailable: network down/);
    assert.doesNotMatch(container.innerHTML, /Registered archive segments: 0|Registered events: 0/);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("archive rerenders restore focus to the same inner summary", async () => {
  const previousDocument = globalThis.document;
  const segmentId = "focused-segment";
  const day = "2026-10-02";
  const oldSummary = {
    tagName: "SUMMARY",
    closest: () => ({ dataset: { archiveSegmentId: segmentId } }),
  };
  const newSummary = {
    focusOptions: null,
    focus(options) {
      this.focusOptions = options;
    },
  };
  const oldMore = {
    tagName: "BUTTON",
    dataset: { archiveDaySegmentId: segmentId, archiveDay: day },
    closest: (selector) => {
      if (selector === "button[data-archive-events-more]") return oldMore;
      if (selector === "details[data-archive-day-segment-id]") {
        return { dataset: { archiveDaySegmentId: segmentId, archiveDay: day } };
      }
      return null;
    },
  };
  const daySummary = {
    focusOptions: null,
    focus(options) {
      this.focusOptions = options;
    },
  };
  const container = {
    innerHTML: "",
    contains: (element) => element === oldSummary || element === oldMore || element === daySummary,
    querySelectorAll: (selector) => {
      if (selector === "details[data-archive-segment-id]") {
        return [{ dataset: { archiveSegmentId: segmentId }, querySelector: () => newSummary }];
      }
      if (selector === "details[data-archive-day-segment-id]") {
        return [{ dataset: { archiveDaySegmentId: segmentId, archiveDay: day }, querySelector: () => daySummary }];
      }
      return [];
    },
  };
  globalThis.document = { activeElement: oldSummary };

  try {
    await refreshHistoryArchives({
      container,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ segments: [], counts: { segments: 0, events: 0 } }),
      }),
    });
    assert.deepEqual(newSummary.focusOptions, { preventScroll: true });

    globalThis.document.activeElement = oldMore;
    rerenderHistoryArchives({ container });
    assert.deepEqual(daySummary.focusOptions, { preventScroll: true });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("snapshot-aware refreshes encode the snapshot and live refreshes omit it", async () => {
  const container = { innerHTML: "" };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ segments: [], counts: { segments: 0, events: 0 } }),
    };
  };
  const snapshotId = "snapshot/a?b&c 中文";

  await refreshHistoryArchives({ container, fetchImpl, snapshotId });
  await refreshHistoryArchives({ container, fetchImpl });

  assert.deepEqual(urls, [`/api/history/archives?snapshot=${encodeURIComponent(snapshotId)}`, "/api/history/archives"]);
});

test("a stale snapshot response cannot overwrite the later live refresh", async () => {
  const container = { innerHTML: "" };
  let resolveSnapshot;
  const snapshotResponse = new Promise((resolve) => {
    resolveSnapshot = resolve;
  });
  const payload = (eventCount) => ({
    segments: [
      {
        segmentId: "segment",
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 60_000,
        eventCount,
        status: "present",
      },
    ],
    counts: { segments: 1, events: eventCount },
  });
  const response = (data) => ({
    ok: true,
    status: 200,
    json: async () => data,
  });

  const frozen = refreshHistoryArchives({
    container,
    snapshotId: "old-snapshot",
    fetchImpl: () => snapshotResponse,
  });
  await refreshHistoryArchives({
    container,
    fetchImpl: async () => response(payload(111)),
  });
  resolveSnapshot(response(payload(222)));
  await frozen;

  assert.match(container.innerHTML, /Archive segment 1/);
  assert.match(container.innerHTML, /Registered events: 111/);
  assert.doesNotMatch(container.innerHTML, /Registered events: 222/);
});

test("sealed UTC days load only after expansion and survive a language rerender", async () => {
  const locale = setLocale("zh-CN", { persist: false });
  const container = { innerHTML: "" };
  const segmentId = "segment/a b";
  const urls = [];
  const archivePayload = {
    segments: [
      {
        segmentId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 60_000,
        eventCount: 4,
        status: "present",
      },
    ],
    counts: { segments: 1, events: 4 },
  };
  const daysPayload = {
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [
      {
        day: "2026-10-02",
        eventCount: 4,
        totals: { total: 40, input: 24, cached: 8, output: 5, reasoning: 3 },
      },
    ],
  };
  const fetchImpl = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => (url === "/api/history/archives" ? archivePayload : daysPayload),
    };
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl });
    assert.deepEqual(urls, ["/api/history/archives"]);
    assert.doesNotMatch(container.innerHTML, /2026-10-02/);

    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: segmentId } },
      { container, fetchImpl, locale: "zh-CN" },
    );

    assert.deepEqual(urls, ["/api/history/archives", "/api/history/archives/segment%2Fa%20b/days"]);
    assert.match(container.innerHTML, /<details[^>]+open[^>]*>/);
    assert.match(container.innerHTML, /封存时数据（UTC 日统计）/);
    assert.match(container.innerHTML, /2026-10-02/);
    assert.match(container.innerHTML, /事件数：4/);
    assert.match(container.innerHTML, /Token 总量：40/);
    assert.match(
      container.innerHTML,
      /<summary class="home-row">[\s\S]*事件数：4[\s\S]*Token 推理：3[\s\S]*<\/summary>/,
    );

    setLocale("en-US", { persist: false });
    rerenderHistoryArchives({ container, locale: "en-US" });
    assert.match(container.innerHTML, /<details[^>]+open[^>]*>/);
    assert.match(container.innerHTML, /Sealed data \(UTC daily totals\)/);
    assert.match(container.innerHTML, /2026-10-02/);
    assert.match(container.innerHTML, /Event count: 4/);
    assert.match(container.innerHTML, /Total tokens: 40/);
    assert.equal(urls.length, 2, "rerendering for locale must not reload sealed days");
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("sealed day token totals preserve signed revisions while event counts stay non-negative", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const signedId = "signed";
  const invalidCountId = "invalid-count";
  const archivePayload = {
    segments: [
      {
        segmentId: signedId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 60_000,
        eventCount: 2,
        status: "present",
      },
      {
        segmentId: invalidCountId,
        startMs: SECOND_START_MS,
        endMs: SECOND_START_MS + 60_000,
        eventCount: 1,
        status: "present",
      },
    ],
    counts: { segments: 2, events: 3 },
  };
  const daysPayload = (segmentId, eventCount) => ({
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [
      {
        day: "2026-10-02",
        eventCount,
        totals: { total: -20, input: -15, cached: -5, output: -1, reasoning: 1 },
      },
    ],
  });
  const fetchImpl = async (url) => {
    if (url === "/api/history/archives") {
      return { ok: true, status: 200, json: async () => archivePayload };
    }
    const segmentId = decodeURIComponent(url.split("/")[4]);
    return {
      ok: true,
      status: 200,
      json: async () => daysPayload(segmentId, segmentId === signedId ? 2 : -1),
    };
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl });
    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: signedId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /Event count: 2/);
    assert.match(container.innerHTML, /Total tokens: -20/);
    assert.match(container.innerHTML, /Input tokens: -15/);
    assert.match(container.innerHTML, /Cached tokens: -5/);
    assert.match(container.innerHTML, /Output tokens: -1/);
    assert.match(container.innerHTML, /Reasoning tokens: 1/);

    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: invalidCountId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /Sealed daily totals unavailable: Invalid sealed daily totals response/);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("sealed day requests carry the active snapshot and stale results cannot overwrite live data", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const segmentId = "segment/old";
  const payload = (eventCount) => ({
    segments: [
      {
        segmentId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 60_000,
        eventCount,
        status: "present",
      },
    ],
    counts: { segments: 1, events: eventCount },
  });
  const response = (data) => ({ ok: true, status: 200, json: async () => data });
  const urls = [];
  let resolveDays;
  const pendingDays = new Promise((resolve) => {
    resolveDays = resolve;
  });
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === "/api/history/archives?snapshot=old-snapshot") return response(payload(1));
    if (url === "/api/history/archives") return response(payload(2));
    if (url.endsWith("/days?snapshot=old-snapshot")) return pendingDays;
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl, snapshotId: "old-snapshot" });
    const staleLoad = handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: segmentId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.ok(urls.includes(`/api/history/archives/${encodeURIComponent(segmentId)}/days?snapshot=old-snapshot`));

    await refreshHistoryArchives({ container, fetchImpl });
    resolveDays(
      response({
        segmentId,
        calendarZone: "utc",
        view: "sealed",
        days: [
          {
            day: "2026-10-01",
            eventCount: 999,
            totals: { total: 999, input: 999, cached: 0, output: 0, reasoning: 0 },
          },
        ],
      }),
    );
    await staleLoad;

    assert.doesNotMatch(container.innerHTML, /2026-10-01|999/);
    assert.match(container.innerHTML, /Expand to load sealed daily totals/);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("missing archives and failed sealed-day requests show unavailable without fake zero counts", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const urls = [];
  const missingId = "missing";
  const failingId = "failing";
  const archivePayload = {
    segments: [
      {
        segmentId: missingId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 60_000,
        eventCount: 10,
        status: "missing",
      },
      {
        segmentId: failingId,
        startMs: SECOND_START_MS,
        endMs: SECOND_START_MS + 60_000,
        eventCount: 20,
        status: "present",
      },
    ],
    counts: { segments: 2, events: 30 },
  };
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === "/api/history/archives") {
      return { ok: true, status: 200, json: async () => archivePayload };
    }
    return { ok: false, status: 500, json: async () => ({ error: "sealed days offline" }) };
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl });
    assert.ok(container.innerHTML.includes(formatLocalDateTime(FIRST_START_MS, "en-US")));
    assert.ok(container.innerHTML.includes(formatLocalDateTime(SECOND_START_MS, "en-US")));

    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: missingId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.deepEqual(urls, ["/api/history/archives"]);
    assert.match(container.innerHTML, /Sealed daily totals unavailable/);

    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: failingId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /Sealed daily totals unavailable: sealed days offline/);
    assert.ok(container.innerHTML.includes(formatLocalDateTime(FIRST_START_MS, "en-US")));
    assert.ok(container.innerHTML.includes(formatLocalDateTime(SECOND_START_MS, "en-US")));
    assert.doesNotMatch(container.innerHTML, /Event count: 0|Total tokens: 0/);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("sealed day expansion requests only that UTC day and renders original event fields", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const segmentId = "segment/day";
  const snapshotId = "snapshot/a b";
  const day = "2026-10-02";
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const endMs = startMs + 86_400_000;
  const eventTimestamp = startMs + 3_725_000;
  const urls = [];
  const archivePayload = {
    segments: [
      {
        segmentId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 86_400_000,
        eventCount: 1,
        status: "present",
      },
    ],
    counts: { segments: 1, events: 1 },
  };
  const daysPayload = {
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [
      {
        day,
        eventCount: 1,
        totals: { total: 20, input: 18, cached: 0, output: 2, reasoning: 0 },
      },
    ],
  };
  const eventPage = {
    segmentId,
    view: "sealed",
    range: { startMs, endMs },
    events: [
      {
        id: 7,
        timestamp_ms: eventTimestamp,
        model: "gpt-6-sol",
        total: 20,
        input: 18,
        cached: 0,
        output: 2,
        reasoning: 0,
      },
    ],
    nextAfterId: 7,
  };
  let resolveEventPage;
  const pendingEventPage = new Promise((resolve) => {
    resolveEventPage = resolve;
  });
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.startsWith("/api/history/archives/") && url.includes("/events?")) return pendingEventPage;
    const data = null;
    return {
      ok: true,
      status: 200,
      json: async () => data || (url.includes("/days") ? daysPayload : archivePayload),
    };
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl, snapshotId });
    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: segmentId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.equal(urls.length, 2, "loading days must not fetch original events");

    const eventLoad = handleHistoryArchiveDayToggle(
      { open: true, dataset: { archiveDaySegmentId: segmentId, archiveDay: day } },
      { container, fetchImpl, locale: "en-US" },
    );

    assert.deepEqual(urls.slice(2), [
      `/api/history/archives/${encodeURIComponent(segmentId)}/events?startMs=${startMs}&endMs=${endMs}&limit=100&snapshot=${encodeURIComponent(snapshotId)}`,
    ]);
    setLocale("zh-CN", { persist: false });
    resolveEventPage({ ok: true, status: 200, json: async () => eventPage });
    await eventLoad;

    assert.match(container.innerHTML, /原始封存版本，不含当前覆盖层。/);
    assert.ok(container.innerHTML.includes(`事件时间：${formatLocalDateTime(eventTimestamp, "zh-CN")}`));
    assert.match(container.innerHTML, /模型名称：gpt-6-sol/);
    assert.match(container.innerHTML, /Token 总量：20/);
    assert.match(container.innerHTML, /Token 输入：18/);
    assert.match(container.innerHTML, /Token 缓存：0/);
    assert.match(container.innerHTML, /Token 输出：2/);
    assert.match(container.innerHTML, /Token 推理：0/);
    assert.match(container.innerHTML, /下一页/);
    assert.doesNotMatch(container.innerHTML, /Original sealed version|Total tokens|Next page/);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("sealed day next pages use the exact cursor and stale snapshot responses cannot replace a new view", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const segmentId = "segment/stale";
  const day = "2026-10-02";
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  const endMs = startMs + 86_400_000;
  const archivePayload = (eventCount) => ({
    segments: [
      {
        segmentId,
        startMs,
        endMs,
        eventCount,
        status: "present",
      },
    ],
    counts: { segments: 1, events: eventCount },
  });
  const daysPayload = {
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [
      {
        day,
        eventCount: 2,
        totals: { total: 40, input: 36, cached: 0, output: 4, reasoning: 0 },
      },
    ],
  };
  const page = (id, nextAfterId) => ({
    segmentId,
    view: "sealed",
    range: { startMs, endMs },
    events: [
      {
        id,
        timestamp_ms: startMs + id * 1_000,
        model: `model-${id}`,
        total: id,
        input: id,
        cached: 0,
        output: 0,
        reasoning: 0,
      },
    ],
    nextAfterId,
  });
  const response = (data) => ({ ok: true, status: 200, json: async () => data });
  const urls = [];
  let resolveStale;
  const staleResponse = new Promise((resolve) => {
    resolveStale = resolve;
  });
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === "/api/history/archives?snapshot=old-snapshot") return response(archivePayload(1));
    if (url === "/api/history/archives") return response(archivePayload(2));
    if (url.includes("/days")) return response(daysPayload);
    if (url.includes("afterId=42")) return staleResponse;
    if (url.includes("/events?")) return response(page(1, 42));
    throw new Error(`unexpected URL: ${url}`);
  };

  const details = { open: true, dataset: { archiveDaySegmentId: segmentId, archiveDay: day } };
  try {
    await refreshHistoryArchives({ container, fetchImpl, snapshotId: "old-snapshot" });
    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: segmentId } },
      { container, fetchImpl, locale: "en-US" },
    );
    await handleHistoryArchiveDayToggle(details, { container, fetchImpl, locale: "en-US" });

    const staleLoad = handleHistoryArchiveNextPage(
      { dataset: { archiveDaySegmentId: segmentId, archiveDay: day } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /data-archive-events-more[^>]*aria-disabled="true"/);
    assert.doesNotMatch(container.innerHTML, /data-archive-events-more[^>]*\sdisabled(?:\s|>)/);
    assert.ok(
      urls.includes(
        `/api/history/archives/${encodeURIComponent(segmentId)}/events?startMs=${startMs}&endMs=${endMs}&limit=100&afterId=42&snapshot=old-snapshot`,
      ),
    );

    await refreshHistoryArchives({ container, fetchImpl });
    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: segmentId } },
      { container, fetchImpl, locale: "en-US" },
    );
    resolveStale(response(page(999, null)));
    await staleLoad;

    assert.doesNotMatch(container.innerHTML, /data-archive-event-id="999"|model-999/);
    assert.match(container.innerHTML, /Expand to load original sealed events\./);
  } finally {
    setLocale(locale, { persist: false });
  }
});

test("missing segments and failed original event pages are explicit and never fabricate events", async () => {
  const locale = setLocale("en-US", { persist: false });
  const container = { innerHTML: "" };
  const missingId = "missing-events";
  const failingId = "failing-events";
  const day = "2026-10-02";
  const urls = [];
  const archivePayload = {
    segments: [
      {
        segmentId: missingId,
        startMs: FIRST_START_MS,
        endMs: FIRST_START_MS + 86_400_000,
        eventCount: 10,
        status: "missing",
      },
      {
        segmentId: failingId,
        startMs: Date.parse(`${day}T00:00:00.000Z`),
        endMs: Date.parse(`${day}T00:00:00.000Z`) + 86_400_000,
        eventCount: 20,
        status: "present",
      },
    ],
    counts: { segments: 2, events: 30 },
  };
  const daysPayload = {
    segmentId: failingId,
    calendarZone: "utc",
    view: "sealed",
    days: [
      {
        day,
        eventCount: 20,
        totals: { total: 40, input: 38, cached: 0, output: 2, reasoning: 0 },
      },
    ],
  };
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === "/api/history/archives") return { ok: true, status: 200, json: async () => archivePayload };
    if (url.includes("/days")) return { ok: true, status: 200, json: async () => daysPayload };
    return { ok: false, status: 404, json: async () => ({ error: "sealed events offline" }) };
  };

  try {
    await refreshHistoryArchives({ container, fetchImpl });
    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: missingId } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /File missing \(range retained; event count unavailable\)/);
    assert.equal(urls.length, 1, "missing segments must not request days or events");
    assert.doesNotMatch(container.innerHTML, /data-archive-day-segment-id="missing-events"/);

    await handleHistoryArchiveToggle(
      { open: true, dataset: { archiveSegmentId: failingId } },
      { container, fetchImpl, locale: "en-US" },
    );
    await handleHistoryArchiveDayToggle(
      { open: true, dataset: { archiveDaySegmentId: failingId, archiveDay: day } },
      { container, fetchImpl, locale: "en-US" },
    );
    assert.match(container.innerHTML, /Original sealed events unavailable: sealed events offline/);
    assert.doesNotMatch(container.innerHTML, /data-archive-event-id=/);
  } finally {
    setLocale(locale, { persist: false });
  }
});
