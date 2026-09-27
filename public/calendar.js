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

export function renderDatePickerHtml({ field = "start", viewDate = new Date(), selectedValue = "" } = {}) {
  const model = datePickerMonthModel(viewDate, selectedValue);
  const escapedField = escapeHtml(field);
  const monthTitle =
    getLocale() === "en-US"
      ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
          new Date(Date.UTC(model.year, model.month - 1, 1)),
        )
      : `${model.year}年${String(model.month).padStart(2, "0")}月`;
  return `
    <div class="date-picker-heading">
      <button class="date-picker-nav" type="button" data-date-picker-action="prev" data-date-picker-field="${escapedField}" aria-label="${localizeText("上个月")}">‹</button>
      <div class="date-picker-title">${monthTitle}</div>
      <button class="date-picker-nav" type="button" data-date-picker-action="next" data-date-picker-field="${escapedField}" aria-label="${localizeText("下个月")}">›</button>
    </div>
    <div class="date-picker-grid">
      ${model.weekdays.map((weekday) => `<div class="date-picker-weekday">${weekday}</div>`).join("")}
      ${model.cells
        .map((cell) => {
          const classes = ["date-picker-day"];
          if (!cell.inCurrentMonth) {
            classes.push("outside-month");
          }
          if (cell.selected) {
            classes.push("selected");
          }
          return `<button type="button" data-date="${cell.date}" data-date-picker-field="${escapedField}" class="${classes.join(" ")}">${cell.day}</button>`;
        })
        .join("")}
    </div>
  `;
}
