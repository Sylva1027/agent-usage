import { getLocale, localizeText } from "./i18n.js";
import { escapeHtml } from "./html-utils.js";

const datePickerWeekdays = ["一", "二", "三", "四", "五", "六", "日"];

export function dateKey(date, zone = "local") {
  const utc = zone === "utc";
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(utc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function normalizeDateInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const date = parseLocalDate(trimmed);
  return date ? dateKey(date) : null;
}

export function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function datePickerMonthModel(viewDate = new Date(), selectedValue = "") {
  const selectedDate = parseLocalDate(selectedValue);
  const visibleMonth = monthStart(viewDate instanceof Date ? viewDate : new Date(viewDate));
  const mondayOffset = (visibleMonth.getDay() + 6) % 7;
  const firstCell = addDays(visibleMonth, -mondayOffset);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(firstCell, index);
    const value = dateKey(date);
    return {
      date: value,
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === visibleMonth.getMonth(),
      selected: selectedDate ? value === dateKey(selectedDate) : false,
    };
  });
  return {
    year: visibleMonth.getFullYear(),
    month: visibleMonth.getMonth() + 1,
    weekdays: getLocale() === "en-US" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : datePickerWeekdays,
    cells,
  };
}

export function selectDateRange({ startDate = "", field = "start" } = {}, value) {
  const selected = normalizeDateInput(value);
  if (!selected) return null;
  const start = normalizeDateInput(startDate);
  if (field !== "end" || !start) {
    return { startDate: selected, endDate: "", field: "end", complete: false };
  }
  return {
    startDate: selected < start ? selected : start,
    endDate: selected < start ? start : selected,
    field: "start",
    complete: true,
  };
}

export function renderDatePickerHtml({ field = "start", viewDate = new Date(), startDate = "", endDate = "" } = {}) {
  const model = datePickerMonthModel(viewDate);
  const start = normalizeDateInput(startDate);
  const end = normalizeDateInput(endDate);
  const hasSelection = Boolean(start || end);
  const monthTitle =
    getLocale() === "en-US"
      ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
          new Date(Date.UTC(model.year, model.month - 1, 1)),
        )
      : `${model.year}年${String(model.month).padStart(2, "0")}月`;
  return `
    <div class="date-picker-heading">
      <button class="date-picker-nav" type="button" data-date-picker-action="prev" aria-label="${localizeText("上个月")}">‹</button>
      <div class="date-picker-title">${monthTitle}</div>
      <button class="date-picker-nav" type="button" data-date-picker-action="next" aria-label="${localizeText("下个月")}">›</button>
    </div>
    <div class="date-picker-grid">
      ${model.weekdays.map((weekday) => `<div class="date-picker-weekday">${weekday}</div>`).join("")}
      ${model.cells
        .map((cell) => {
          const classes = ["date-picker-day"];
          if (!cell.inCurrentMonth) {
            classes.push("outside-month");
          }
          const isStart = cell.date === start;
          const isEnd = cell.date === end;
          if (isStart || isEnd) classes.push("selected");
          if (isStart) classes.push("range-start");
          if (isEnd) classes.push("range-end");
          if (start && end && cell.date > start && cell.date < end) classes.push("in-range");
          const labels = [cell.date];
          if (isStart) labels.push(localizeText("开始日期"));
          if (isEnd) labels.push(localizeText("结束日期"));
          return `<button type="button" data-date="${cell.date}" class="${classes.join(" ")}" aria-label="${escapeHtml(labels.join(" · "))}" aria-pressed="${isStart || isEnd}">${cell.day}</button>`;
        })
        .join("")}
    </div>
    <div class="date-picker-footer">
      <div class="date-picker-hint picking-${field === "end" ? "end" : "start"}" role="status">${localizeText(field === "end" ? "选择结束日期" : "选择开始日期")}</div>
      <button type="button" class="date-picker-clear" data-date-picker-clear${hasSelection ? "" : " disabled"} aria-label="${localizeText("清除日期范围")}">${localizeText("清除")}</button>
    </div>
  `;
}
