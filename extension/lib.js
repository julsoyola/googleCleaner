"use strict";

// GoogleCleaner shared pure logic. No chrome.* APIs here so it can be
// loaded both in the extension (popup.html <script> / background.js
// importScripts) and in plain Node for automated tests.

const FRIENDLY_TYPE = {
  "application/vnd.google-apps.document": "Doc",
  "application/vnd.google-apps.spreadsheet": "Sheet",
  "application/vnd.google-apps.presentation": "Slides",
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.shortcut": "Shortcut",
  "application/pdf": "PDF",
};

const MIME_BY_FILTER = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slide: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  folder: "application/vnd.google-apps.folder",
};

// --- date range helpers ----------------------------------------------

function parseLocalDateStart(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function parseLocalDateEnd(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
}

// Returns null for "any time", { error } for an invalid custom range,
// or { start: Date, end: Date } (both inclusive, local timezone) otherwise.
function computeDateRange(filterId, extra, now) {
  const nowDate = now ? new Date(now) : new Date();
  switch (filterId) {
    case "any":
    case undefined:
    case null:
      return null;
    case "7d":
      return { start: new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000), end: nowDate };
    case "30d":
      return { start: new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000), end: nowDate };
    case "1y": {
      // Rolling 1-year window ending now, NOT Jan 1 -> Dec 31 of the current year.
      const start = new Date(nowDate.getTime());
      start.setFullYear(start.getFullYear() - 1);
      return { start, end: nowDate };
    }
    case "month": {
      const year = extra && extra.year;
      const month = extra && extra.month; // 1-12
      if (!year || !month) return { error: "missing-month" };
      const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
      const end = new Date(year, month, 0, 23, 59, 59, 999); // day 0 of next month = last day of this month
      return { start, end };
    }
    case "year": {
      const year = extra && extra.year;
      if (!year) return { error: "missing-year" };
      const start = new Date(year, 0, 1, 0, 0, 0, 0);
      const end = new Date(year, 11, 31, 23, 59, 59, 999);
      return { start, end };
    }
    case "range": {
      const start = parseLocalDateStart(extra && extra.from);
      const end = parseLocalDateEnd(extra && extra.to);
      if (!start || !end) return { error: "missing-range" };
      if (start.getTime() > end.getTime()) return { error: "invalid-range" };
      return { start, end };
    }
    default:
      return null;
  }
}

function matchesDateRange(modifiedTimeIso, range) {
  if (!range) return true;
  if (range.error) return false;
  const t = new Date(modifiedTimeIso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= range.start.getTime() && t <= range.end.getTime();
}

// --- filtering & sorting -----------------------------------------------

function matchesFile(file, { type, search, dateRange }) {
  if (type && type !== "all") {
    const wanted = MIME_BY_FILTER[type];
    if (file.mimeType !== wanted) return false;
  }
  if (search) {
    if (!file.name.toLowerCase().includes(search.toLowerCase())) return false;
  }
  if (!matchesDateRange(file.modifiedTime, dateRange)) return false;
  return true;
}

function filterFiles(files, options) {
  return files.filter((f) => matchesFile(f, options));
}

function numericSize(file) {
  if (file.size === undefined || file.size === null) return null;
  const n = Number(file.size);
  return Number.isFinite(n) ? n : null;
}

function sortFiles(files, sortKey) {
  const copy = files.slice();
  switch (sortKey) {
    case "oldest":
      copy.sort((a, b) => new Date(a.modifiedTime) - new Date(b.modifiedTime));
      break;
    case "newest":
      copy.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      break;
    case "largest":
      copy.sort((a, b) => {
        const sa = numericSize(a);
        const sb = numericSize(b);
        if (sa === null && sb === null) return 0;
        if (sa === null) return 1; // unknown sizes sort to the end, explicitly
        if (sb === null) return -1;
        return sb - sa;
      });
      break;
    case "name-asc":
    default:
      copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      break;
  }
  return copy;
}

// --- storage summary -----------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function summarizeSize(files) {
  let totalBytes = 0;
  let unknownCount = 0;
  for (const file of files) {
    const n = numericSize(file);
    if (n === null) unknownCount++;
    else totalBytes += n;
  }
  return { totalBytes, unknownCount, knownCount: files.length - unknownCount };
}

// --- background job (pure state transitions, no chrome.* calls) ---------

function createJob({ id, account, items }) {
  const now = Date.now();
  return {
    id,
    account,
    createdAt: now,
    updatedAt: now,
    status: "processing", // processing | paused_reauth | done
    items: items.map((it) => ({
      id: it.id,
      name: it.name,
      status: "pending", // pending | ok | failed
      attempts: 0,
      error: null,
    })),
  };
}

function nextPendingItem(job) {
  return job.items.find((it) => it.status === "pending") || null;
}

function markItemResult(job, itemId, ok, error) {
  const item = job.items.find((it) => it.id === itemId);
  if (!item) return job;
  item.status = ok ? "ok" : "failed";
  item.error = ok ? null : error || "Unknown error";
  item.attempts = (item.attempts || 0) + 1;
  job.updatedAt = Date.now();
  if (!job.items.some((it) => it.status === "pending")) {
    job.status = "done";
  }
  return job;
}

function resetFailedItems(job) {
  let changed = false;
  for (const item of job.items) {
    if (item.status === "failed") {
      item.status = "pending";
      item.error = null;
      changed = true;
    }
  }
  if (changed) job.status = "processing";
  job.updatedAt = Date.now();
  return job;
}

function jobCounts(job) {
  const counts = { pending: 0, ok: 0, failed: 0 };
  for (const item of job.items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  return counts;
}

function isJobActive(job) {
  return !!job && (job.status === "processing" || job.status === "paused_reauth");
}

function backoffDelayMs(attempt, baseMs, maxMs) {
  const base = baseMs || 500;
  const max = maxMs || 16000;
  const delay = Math.min(max, base * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 250);
  return delay + jitter;
}

const GCLib = {
  FRIENDLY_TYPE,
  MIME_BY_FILTER,
  parseLocalDateStart,
  parseLocalDateEnd,
  computeDateRange,
  matchesDateRange,
  matchesFile,
  filterFiles,
  numericSize,
  sortFiles,
  formatBytes,
  summarizeSize,
  createJob,
  nextPendingItem,
  markItemResult,
  resetFailedItems,
  jobCounts,
  isJobActive,
  backoffDelayMs,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = GCLib;
}
