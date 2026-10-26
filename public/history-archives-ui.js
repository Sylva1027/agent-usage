import { escapeHtml } from "./html-utils.js";
import { formatLocalDateTime, getLocale, localizeText } from "./i18n.js";

const STATUS_COPY = Object.freeze({
  present: "已登记（仅表示文件存在，未验证内容）",
  missing: "文件缺失（范围保留，事件数不可用）",
  unreadable: "文件不可读（范围保留，事件数不可用）",
  unknown: "归档状态未知（事件数不可用）",
});

let archiveLoadId = 0;
let archiveView = { phase: "loading" };
let archiveDays = new Map();
let archiveDayLoadIds = new Map();
let archiveEventStates = new Map();
let archiveEventLoadIds = new Map();
let archiveOpenSegments = new Set();
let archiveOpenDays = new Set();
const archiveToggleTargets = new WeakSet();
const archiveEventPageTargets = new WeakSet();

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSignedInteger(value) {
  return Number.isSafeInteger(value);
}

function utcDayBounds(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const startMs = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(startMs) ? { startMs, endMs: startMs + 86_400_000 } : null;
}

function archiveDayKey(segmentId, day) {
  return `${segmentId}\u0000${day}`;
}

function formatCount(value, locale) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatRange(segment, locale) {
  const label = localizeText("范围", locale);
  const labelSeparator = locale === "en-US" ? ": " : "：";
  const rangeSeparator = locale === "en-US" ? " – " : " 至 ";
  const start = Number.isFinite(segment?.startMs)
    ? formatLocalDateTime(segment.startMs, locale)
    : localizeText("未知时间", locale);
  const end = Number.isFinite(segment?.endMs)
    ? formatLocalDateTime(segment.endMs, locale)
    : localizeText("未知时间", locale);
  return `${label}${labelSeparator}${start}${rangeSeparator}${end}`;
}

function segmentYear(segment) {
  const { startMs, endMs } = segment || {};
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  const start = new Date(startMs);
  const end = new Date(endMs - 1);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const startYear = start.getFullYear();
  return end.getFullYear() === startYear ? startYear : null;
}

export function historyArchiveBands(segments) {
  const bands = [];
  let previous = null;
  for (const segment of segments) {
    const year = segmentYear(segment);
    if (previous && year === previous.year && previous.endMs === segment.startMs) {
      previous.band.segments.push(segment);
      previous.endMs = segment.endMs;
      continue;
    }
    const band = { year, segments: [segment] };
    bands.push(band);
    previous = year === null ? null : { band, endMs: segment.endMs, year };
  }
  return bands;
}

function countLabel(label, value, locale) {
  return `${localizeText(label, locale)}${locale === "en-US" ? ": " : "："}${formatCount(value, locale)}`;
}

function segmentFor(segmentId) {
  if (archiveView.phase !== "loaded") return null;
  return archiveView.data.segments.find((segment) => segment?.segmentId === segmentId) || null;
}

function validDayPayload(payload, segmentId) {
  return (
    payload?.segmentId === segmentId &&
    payload?.calendarZone === "utc" &&
    payload?.view === "sealed" &&
    Array.isArray(payload?.days) &&
    payload.days.every(
      (day) =>
        typeof day?.day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(day.day) &&
        validCount(day.eventCount) &&
        validSignedInteger(day.totals?.total) &&
        validSignedInteger(day.totals?.input) &&
        validSignedInteger(day.totals?.cached) &&
        validSignedInteger(day.totals?.output) &&
        validSignedInteger(day.totals?.reasoning),
    )
  );
}

function validEventPagePayload(payload, segmentId, { startMs, endMs }) {
  return (
    payload?.segmentId === segmentId &&
    payload?.view === "sealed" &&
    payload?.range?.startMs === startMs &&
    payload?.range?.endMs === endMs &&
    Array.isArray(payload?.events) &&
    payload.events.every(
      (event) =>
        event &&
        typeof event === "object" &&
        validCount(event.id) &&
        Number.isSafeInteger(event.timestamp_ms) &&
        event.timestamp_ms >= startMs &&
        event.timestamp_ms < endMs &&
        typeof event.model === "string" &&
        validSignedInteger(event.total) &&
        validSignedInteger(event.input) &&
        validSignedInteger(event.cached) &&
        validSignedInteger(event.output) &&
        validSignedInteger(event.reasoning),
    ) &&
    (payload.nextAfterId === null || validCount(payload.nextAfterId))
  );
}

function renderSealedEvent(event, locale) {
  const metrics = [
    ["Token 总量", event.total],
    ["Token 输入", event.input],
    ["Token 缓存", event.cached],
    ["Token 输出", event.output],
    ["Token 推理", event.reasoning],
  ];
  return `
    <div class="home-row" data-archive-event-id="${event.id}">
      <div class="home-label">
        <strong>${escapeHtml(
          `${localizeText("事件时间", locale)}${locale === "en-US" ? ": " : "："}${formatLocalDateTime(
            event.timestamp_ms,
            locale,
          )}`,
        )}</strong>
        <span class="home-kind">${escapeHtml(
          `${localizeText("模型名称", locale)}${locale === "en-US" ? ": " : "："}${event.model}`,
        )}</span>
      </div>
      <div class="home-meta">
        ${metrics.map(([label, value]) => `<span>${escapeHtml(countLabel(label, value, locale))}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderSealedEvents(segmentId, day, locale, { eventStates }) {
  const key = archiveDayKey(segmentId, day);
  const state = eventStates.get(key) || { phase: "idle" };
  const nextButton = (disabled = false) => `
    <button
      type="button"
      class="home-kind"
      data-archive-events-more
      data-archive-day-segment-id="${escapeHtml(segmentId)}"
      data-archive-day="${escapeHtml(day)}"
      ${disabled ? 'aria-disabled="true"' : ""}
    >${escapeHtml(localizeText(disabled ? "正在读取下一页…" : "下一页", locale))}</button>
  `;
  const events = Array.isArray(state.events) ? state.events : [];
  const rows = events.length
    ? `<div class="home-list">${events.map((event) => renderSealedEvent(event, locale)).join("")}</div>`
    : "";
  let content;
  if (state.phase === "loading") {
    content = `<div class="empty" role="status">${escapeHtml(localizeText("正在读取原始封存事件…", locale))}</div>`;
  } else if (state.phase === "loadingMore") {
    content = `${rows}<div class="empty" role="status">${escapeHtml(
      localizeText("正在读取下一页…", locale),
    )}</div>${nextButton(true)}`;
  } else if (state.phase === "error") {
    const separator = locale === "en-US" ? ": " : "：";
    content = `${rows}<div class="empty" role="status">${escapeHtml(
      `${localizeText("原始封存事件不可用", locale)}${separator}${state.message || "Unknown error"}`,
    )}</div>`;
  } else if (state.phase === "loaded") {
    content = rows
      ? `${rows}${state.nextAfterId === null ? "" : nextButton()}`
      : `<div class="empty">${escapeHtml(localizeText("没有原始封存事件。", locale))}</div>`;
  } else {
    content = `<div class="empty">${escapeHtml(localizeText("展开后读取原始封存事件。", locale))}</div>`;
  }
  return `
    <div class="home-meta"><span>${escapeHtml(localizeText("原始封存版本，不含当前覆盖层。", locale))}</span></div>
    ${content}
  `;
}

function renderSealedDay(segmentId, day, locale, { eventStates, openDays }) {
  const key = archiveDayKey(segmentId, day.day);
  const metrics = [
    ["事件数", day.eventCount],
    ["Token 总量", day.totals.total],
    ["Token 输入", day.totals.input],
    ["Token 缓存", day.totals.cached],
    ["Token 输出", day.totals.output],
    ["Token 推理", day.totals.reasoning],
  ];
  return `
    <details
      data-archive-day-segment-id="${escapeHtml(segmentId)}"
      data-archive-day="${escapeHtml(day.day)}"
      ${openDays.has(key) ? "open" : ""}
    >
      <summary class="home-row">
        <span class="home-label"><strong>${escapeHtml(day.day)}</strong></span>
        <span class="home-meta">
          ${metrics.map(([label, value]) => `<span>${escapeHtml(countLabel(label, value, locale))}</span>`).join("")}
        </span>
      </summary>
      ${renderSealedEvents(segmentId, day.day, locale, { eventStates })}
    </details>
  `;
}

function renderSealedDays(segment, status, { locale, dayStates, openSegments, eventStates, openDays }) {
  const segmentId = typeof segment?.segmentId === "string" ? segment.segmentId : "";
  const state = dayStates.get(segmentId) || { phase: status === "present" ? "idle" : "unavailable" };
  let content;
  if (status !== "present" || state.phase === "unavailable") {
    content = `<div class="empty">${escapeHtml(localizeText("封存日统计不可用。", locale))}</div>`;
  } else if (state.phase === "loading") {
    content = `<div class="empty" role="status">${escapeHtml(localizeText("正在读取封存日统计…", locale))}</div>`;
  } else if (state.phase === "error") {
    const separator = locale === "en-US" ? ": " : "：";
    content = `<div class="empty" role="status">${escapeHtml(
      `${localizeText("封存日统计不可用", locale)}${separator}${state.message || "Unknown error"}`,
    )}</div>`;
  } else if (state.phase === "loaded") {
    content = state.days.length
      ? `<div class="home-list">${state.days
          .map((day) => renderSealedDay(segmentId, day, locale, { eventStates, openDays }))
          .join("")}</div>`
      : `<div class="empty">${escapeHtml(localizeText("没有封存日统计。", locale))}</div>`;
  } else {
    content = `<div class="empty">${escapeHtml(localizeText("展开后读取封存日统计。", locale))}</div>`;
  }

  return `
    <details data-archive-segment-id="${escapeHtml(segmentId)}"${openSegments.has(segmentId) ? " open" : ""}>
      <summary class="home-kind">${escapeHtml(localizeText("封存时数据（UTC 日统计）", locale))}</summary>
      <div class="home-meta"><span>${escapeHtml(localizeText("原始封存版本，不含当前覆盖层。", locale))}</span></div>
      ${content}
    </details>
  `;
}

export function renderHistoryArchivesHtml(
  payload,
  {
    locale = getLocale(),
    dayStates = archiveDays,
    openSegments = archiveOpenSegments,
    eventStates = archiveEventStates,
    openDays = archiveOpenDays,
  } = {},
) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  if (!segments.length) {
    return `<div class="empty">${escapeHtml(localizeText("没有已登记的归档段。", locale))}</div>`;
  }

  const segmentCount = validCount(payload?.counts?.segments) ? payload.counts.segments : segments.length;
  const eventCount = validCount(payload?.counts?.events)
    ? payload.counts.events
    : segments.reduce((sum, segment) => sum + (validCount(segment?.eventCount) ? segment.eventCount : 0), 0);
  let segmentIndex = 0;
  const rows = historyArchiveBands(segments)
    .map((band) => {
      const bandYear = band.year === null ? "unknown" : String(band.year);
      const bandLabel =
        band.year === null ? localizeText("归档带", locale) : `${band.year} ${localizeText("归档带", locale)}`;
      const segmentRows = band.segments
        .map((segment) => {
          const index = segmentIndex++;
          const status = Object.hasOwn(STATUS_COPY, segment?.status) ? segment.status : "unknown";
          const registeredEvents =
            status !== "present"
              ? ""
              : validCount(segment?.eventCount)
                ? `<span>${escapeHtml(countLabel("已登记事件", segment.eventCount, locale))}</span>`
                : `<span>${escapeHtml(localizeText("事件数不可用", locale))}</span>`;
          const range = formatRange(segment, locale);
          return `
        <div class="home-row">
          <div class="home-label">
            <strong>${escapeHtml(`${localizeText("归档段", locale)} ${index + 1}`)}</strong>
          </div>
          <div class="home-meta">
            <span class="home-status">${escapeHtml(localizeText(STATUS_COPY[status], locale))}</span>
            ${registeredEvents}
          </div>
          <div class="home-path" title="${escapeHtml(range)}">${escapeHtml(range)}</div>
          ${renderSealedDays(segment, status, { locale, dayStates, openSegments, eventStates, openDays })}
        </div>
      `;
        })
        .join("");
      return `
        <div class="archive-band" data-archive-band-year="${escapeHtml(bandYear)}">
          <div class="home-row">
            <div class="home-label"><strong>${escapeHtml(bandLabel)}</strong></div>
          </div>
          ${segmentRows}
        </div>
      `;
    })
    .join("");

  return `
    <div class="home-meta">
      <span>${escapeHtml(countLabel("已登记归档段", segmentCount, locale))}</span>
      <span aria-hidden="true">·</span>
      <span>${escapeHtml(countLabel("已登记事件", eventCount, locale))}</span>
    </div>
    ${rows}
  `;
}

export function renderHistoryArchivesState(view, { locale = getLocale() } = {}) {
  if (view?.phase === "loaded") return renderHistoryArchivesHtml(view.data, { locale });
  if (view?.phase === "error") {
    return `<div class="empty" role="status">${escapeHtml(
      localizeText(`归档状态不可用：${view.message || "Unknown error"}`, locale),
    )}</div>`;
  }
  return `<div class="empty" role="status">${escapeHtml(localizeText("正在读取归档状态…", locale))}</div>`;
}

function containerFor(container) {
  return container || globalThis.document?.querySelector?.("#historyArchivesList") || null;
}

function focusedArchiveControl(target) {
  const active = globalThis.document?.activeElement;
  if (!target?.contains?.(active)) return null;
  const dayDetails = active.closest?.("details[data-archive-day-segment-id]");
  const daySegmentId = dayDetails?.dataset?.archiveDaySegmentId;
  const day = dayDetails?.dataset?.archiveDay;
  if (active.tagName === "SUMMARY" && daySegmentId && day) {
    return {
      kind: "day",
      segmentId: daySegmentId,
      day,
    };
  }
  const segmentId = active.closest?.("details[data-archive-segment-id]")?.dataset?.archiveSegmentId;
  if (active.tagName === "SUMMARY" && segmentId) return { kind: "segment", segmentId };
  const more = active.closest?.("button[data-archive-events-more]");
  if (more) {
    return {
      kind: "more",
      segmentId: more.dataset.archiveDaySegmentId,
      day: more.dataset.archiveDay,
    };
  }
  return null;
}

function restoreArchiveFocus(target, control) {
  if (!control || !target?.querySelectorAll) return;
  if (control.kind === "segment") {
    const details = [...target.querySelectorAll("details[data-archive-segment-id]")].find(
      (element) => element?.dataset?.archiveSegmentId === control.segmentId,
    );
    details?.querySelector?.(":scope > summary")?.focus?.({ preventScroll: true });
    return;
  }
  if (control.kind === "day") {
    const details = [...target.querySelectorAll("details[data-archive-day-segment-id]")].find(
      (element) =>
        element?.dataset?.archiveDaySegmentId === control.segmentId && element?.dataset?.archiveDay === control.day,
    );
    details?.querySelector?.(":scope > summary")?.focus?.({ preventScroll: true });
    return;
  }
  if (control.kind === "more") {
    const button = [...target.querySelectorAll("button[data-archive-events-more]")].find(
      (element) =>
        element?.dataset?.archiveDaySegmentId === control.segmentId && element?.dataset?.archiveDay === control.day,
    );
    if (button) {
      button.focus?.({ preventScroll: true });
      return;
    }
    const details = [...target.querySelectorAll("details[data-archive-day-segment-id]")].find(
      (element) =>
        element?.dataset?.archiveDaySegmentId === control.segmentId && element?.dataset?.archiveDay === control.day,
    );
    const daySummary = details?.querySelector?.(":scope > summary");
    if (daySummary) {
      daySummary.focus?.({ preventScroll: true });
      return;
    }
    const segmentDetails = [...target.querySelectorAll("details[data-archive-segment-id]")].find(
      (element) => element?.dataset?.archiveSegmentId === control.segmentId,
    );
    segmentDetails?.querySelector?.(":scope > summary")?.focus?.({ preventScroll: true });
  }
}

export function rerenderHistoryArchives({ container, locale = getLocale() } = {}) {
  const target = containerFor(container);
  if (!target) return;
  const focusedControl = focusedArchiveControl(target);
  target.innerHTML = renderHistoryArchivesState(archiveView, { locale });
  restoreArchiveFocus(target, focusedControl);
}

function daysUrl(segmentId, snapshotId) {
  const base = `/api/history/archives/${encodeURIComponent(segmentId)}/days`;
  return snapshotId ? `${base}?snapshot=${encodeURIComponent(snapshotId)}` : base;
}

function eventsUrl(segmentId, { startMs, endMs }, afterId, snapshotId) {
  const query = [`startMs=${startMs}`, `endMs=${endMs}`, "limit=100"];
  if (afterId !== null) query.push(`afterId=${afterId}`);
  if (snapshotId) query.push(`snapshot=${encodeURIComponent(snapshotId)}`);
  return `/api/history/archives/${encodeURIComponent(segmentId)}/events?${query.join("&")}`;
}

async function loadHistoryArchiveEventPage(
  { segmentId, day, afterId = null },
  { fetchImpl = globalThis.fetch, container, locale = getLocale() } = {},
) {
  const bounds = utcDayBounds(day);
  const segment = segmentFor(segmentId);
  if (!bounds || segment?.status !== "present") return;
  const key = archiveDayKey(segmentId, day);
  const existing = archiveEventStates.get(key);
  const previousEvents = afterId === null || !Array.isArray(existing?.events) ? [] : existing.events;
  const generation = archiveLoadId;
  const snapshotId = archiveView.snapshotId;
  const loadId = (archiveEventLoadIds.get(key) || 0) + 1;
  archiveEventLoadIds.set(key, loadId);
  archiveEventStates.set(key, {
    phase: afterId === null ? "loading" : "loadingMore",
    events: previousEvents,
    nextAfterId: afterId,
  });
  rerenderHistoryArchives({ container, locale });

  try {
    const response = await fetchImpl(eventsUrl(segmentId, bounds, afterId, snapshotId));
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || data?.code || `API ${response.status}`);
    }
    if (!validEventPagePayload(data, segmentId, bounds)) {
      throw new Error(localizeText("原始封存事件格式无效", locale));
    }
    if (generation !== archiveLoadId || archiveEventLoadIds.get(key) !== loadId) return;
    archiveEventStates.set(key, {
      phase: "loaded",
      events: [...previousEvents, ...data.events],
      nextAfterId: data.nextAfterId,
    });
  } catch (error) {
    if (generation !== archiveLoadId || archiveEventLoadIds.get(key) !== loadId) return;
    archiveEventStates.set(key, {
      phase: "error",
      events: previousEvents,
      nextAfterId: afterId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  rerenderHistoryArchives({ container });
}

export async function handleHistoryArchiveToggle(
  details,
  { fetchImpl = globalThis.fetch, container, locale = getLocale() } = {},
) {
  const segmentId = details?.dataset?.archiveSegmentId;
  if (!segmentId || archiveView.phase !== "loaded") return;
  if (details.open) archiveOpenSegments.add(segmentId);
  else archiveOpenSegments.delete(segmentId);
  if (!details.open) return;

  const segment = segmentFor(segmentId);
  const existing = archiveDays.get(segmentId);
  if (segment?.status !== "present" || (existing && existing.phase !== "error")) return;

  const generation = archiveLoadId;
  const loadId = (archiveDayLoadIds.get(segmentId) || 0) + 1;
  archiveDayLoadIds.set(segmentId, loadId);
  archiveDays.set(segmentId, { phase: "loading" });
  rerenderHistoryArchives({ container, locale });

  try {
    const response = await fetchImpl(daysUrl(segmentId, archiveView.snapshotId));
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || data?.code || `API ${response.status}`);
    }
    if (!validDayPayload(data, segmentId)) {
      throw new Error(localizeText("封存日统计格式无效", locale));
    }
    if (generation !== archiveLoadId || archiveDayLoadIds.get(segmentId) !== loadId) return;
    archiveDays.set(segmentId, { phase: "loaded", days: data.days });
  } catch (error) {
    if (generation !== archiveLoadId || archiveDayLoadIds.get(segmentId) !== loadId) return;
    archiveDays.set(segmentId, {
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  rerenderHistoryArchives({ container });
}

export async function handleHistoryArchiveDayToggle(
  details,
  { fetchImpl = globalThis.fetch, container, locale = getLocale() } = {},
) {
  const segmentId = details?.dataset?.archiveDaySegmentId;
  const day = details?.dataset?.archiveDay;
  if (!segmentId || !utcDayBounds(day) || archiveView.phase !== "loaded") return;
  const key = archiveDayKey(segmentId, day);
  if (details.open) archiveOpenDays.add(key);
  else archiveOpenDays.delete(key);
  if (!details.open) return;

  const existing = archiveEventStates.get(key);
  if (existing && existing.phase !== "error") return;
  await loadHistoryArchiveEventPage({ segmentId, day }, { fetchImpl, container, locale });
}

export async function handleHistoryArchiveNextPage(
  button,
  { fetchImpl = globalThis.fetch, container, locale = getLocale() } = {},
) {
  const segmentId = button?.dataset?.archiveDaySegmentId;
  const day = button?.dataset?.archiveDay;
  if (!segmentId || !utcDayBounds(day) || archiveView.phase !== "loaded") return;
  const state = archiveEventStates.get(archiveDayKey(segmentId, day));
  if (state?.phase !== "loaded" || !validCount(state.nextAfterId)) return;
  await loadHistoryArchiveEventPage({ segmentId, day, afterId: state.nextAfterId }, { fetchImpl, container, locale });
}

export async function refreshHistoryArchives({
  fetchImpl = globalThis.fetch,
  container,
  locale = getLocale(),
  snapshotId,
} = {}) {
  const loadId = ++archiveLoadId;
  archiveView = { phase: "loading" };
  archiveDays = new Map();
  archiveDayLoadIds = new Map();
  archiveEventStates = new Map();
  archiveEventLoadIds = new Map();
  archiveOpenSegments = new Set();
  archiveOpenDays = new Set();
  rerenderHistoryArchives({ container, locale });

  try {
    const url = snapshotId
      ? `/api/history/archives?snapshot=${encodeURIComponent(snapshotId)}`
      : "/api/history/archives";
    const response = await fetchImpl(url);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || data?.code || `API ${response.status}`);
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.segments) || typeof data.counts !== "object") {
      throw new Error(localizeText("归档响应格式无效", locale));
    }
    if (loadId !== archiveLoadId) return;
    archiveView = {
      phase: "loaded",
      data,
      snapshotId: typeof snapshotId === "string" && snapshotId ? snapshotId : null,
    };
  } catch (error) {
    if (loadId !== archiveLoadId) return;
    archiveView = { phase: "error", message: error instanceof Error ? error.message : String(error) };
  }
  rerenderHistoryArchives({ container });
}

function listenForArchiveToggles(target, fetchImpl, renderContainer) {
  if (!target?.addEventListener || archiveToggleTargets.has(target)) return;
  archiveToggleTargets.add(target);
  target.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (details?.matches?.("[data-archive-day-segment-id]")) {
        void handleHistoryArchiveDayToggle(details, { fetchImpl, container: renderContainer });
      } else if (details?.matches?.("[data-archive-segment-id]")) {
        void handleHistoryArchiveToggle(details, { fetchImpl, container: renderContainer });
      }
    },
    true,
  );
}

function listenForArchiveEventPages(target, fetchImpl, renderContainer) {
  if (!target?.addEventListener || archiveEventPageTargets.has(target)) return;
  archiveEventPageTargets.add(target);
  target.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-archive-events-more]");
    if (!button) return;
    event.preventDefault();
    void handleHistoryArchiveNextPage(button, { fetchImpl, container: renderContainer });
  });
}

export function mountHistoryArchives({ fetchImpl = globalThis.fetch, container } = {}) {
  const target = containerFor(container) || globalThis.document;
  listenForArchiveToggles(target, fetchImpl, container);
  listenForArchiveEventPages(target, fetchImpl, container);
  return {
    refresh: (options = {}) => refreshHistoryArchives({ fetchImpl, container, ...options }),
    rerender: () => rerenderHistoryArchives({ container }),
  };
}
