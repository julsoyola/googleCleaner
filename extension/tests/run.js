"use strict";

// Automated, environment-agnostic checks for extension/lib.js.
// Run with: node extension/tests/run.js
// These exercise pure logic only (date boundaries, combined filters,
// sorting/missing sizes, and job state transitions used by background.js).
// They do NOT touch chrome.* APIs, so they cannot verify real Chrome
// behavior (popup rendering, service worker suspension, actual network
// calls) -- that still requires manual testing in Chrome.

const assert = require("assert");
const path = require("path");
const GCLib = require(path.join(__dirname, "..", "lib.js"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

// --- date boundaries ---------------------------------------------------

test("past year is a rolling 1-year window ending now, not Jan 1 onward", () => {
  const now = new Date(2026, 5, 15, 10, 0, 0).getTime(); // Jun 15 2026
  const range = GCLib.computeDateRange("1y", {}, now);
  assert.strictEqual(range.start.getFullYear(), 2025);
  assert.strictEqual(range.start.getMonth(), 5); // June
  assert.strictEqual(range.start.getDate(), 15);
  assert.strictEqual(range.end.getTime(), now);
});

test("choose month includes the full final day (leap year Feb 2024)", () => {
  const range = GCLib.computeDateRange("month", { year: 2024, month: 2 });
  assert.strictEqual(range.start.getDate(), 1);
  assert.strictEqual(range.end.getDate(), 29);
  assert.strictEqual(range.end.getHours(), 23);
  assert.strictEqual(range.end.getMinutes(), 59);
});

test("choose month includes the full final day (non-leap year Feb 2023)", () => {
  const range = GCLib.computeDateRange("month", { year: 2023, month: 2 });
  assert.strictEqual(range.end.getDate(), 28);
});

test("choose year spans Jan 1 00:00 to Dec 31 23:59:59.999 local", () => {
  const range = GCLib.computeDateRange("year", { year: 2022 });
  assert.strictEqual(range.start.getMonth(), 0);
  assert.strictEqual(range.start.getDate(), 1);
  assert.strictEqual(range.end.getMonth(), 11);
  assert.strictEqual(range.end.getDate(), 31);
  assert.strictEqual(range.end.getHours(), 23);
  assert.strictEqual(range.end.getMilliseconds(), 999);
});

test("custom range includes the full final day", () => {
  const range = GCLib.computeDateRange("range", { from: "2026-01-01", to: "2026-01-03" });
  assert.strictEqual(range.start.getHours(), 0);
  assert.strictEqual(range.end.getDate(), 3);
  assert.strictEqual(range.end.getHours(), 23);
  assert.strictEqual(range.end.getMinutes(), 59);
});

test("custom range rejects From after To", () => {
  const range = GCLib.computeDateRange("range", { from: "2026-02-01", to: "2026-01-01" });
  assert.strictEqual(range.error, "invalid-range");
});

test("custom range rejects missing From/To", () => {
  const range = GCLib.computeDateRange("range", { from: "2026-02-01" });
  assert.strictEqual(range.error, "missing-range");
});

test("any time applies no filtering", () => {
  assert.strictEqual(GCLib.computeDateRange("any", {}), null);
  assert.strictEqual(GCLib.matchesDateRange("2000-01-01T00:00:00Z", null), true);
});

test("matchesDateRange is inclusive of both boundaries", () => {
  const range = { start: new Date(2026, 0, 1, 0, 0, 0, 0), end: new Date(2026, 0, 1, 23, 59, 59, 999) };
  assert.strictEqual(GCLib.matchesDateRange(new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(), range), true);
  assert.strictEqual(GCLib.matchesDateRange(new Date(2026, 0, 1, 23, 59, 59, 999).toISOString(), range), true);
  assert.strictEqual(GCLib.matchesDateRange(new Date(2025, 11, 31, 23, 59, 59, 0).toISOString(), range), false);
});

// --- combined filters (type + search + date) ---------------------------

test("filterFiles combines type, search, and date filters", () => {
  const files = [
    { id: "1", name: "Budget Doc", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-05-01T00:00:00Z" },
    { id: "2", name: "Budget Sheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-05-01T00:00:00Z" },
    { id: "3", name: "Old Doc", mimeType: "application/vnd.google-apps.document", modifiedTime: "2020-01-01T00:00:00Z" },
  ];
  const dateRange = GCLib.computeDateRange("year", { year: 2026 });
  const result = GCLib.filterFiles(files, { type: "doc", search: "budget", dateRange });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, "1");
});

test("filterFiles with type=all and no search only applies the date filter", () => {
  const files = [
    { id: "1", name: "A", mimeType: "application/pdf", modifiedTime: "2026-05-01T00:00:00Z" },
    { id: "2", name: "B", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2020-05-01T00:00:00Z" },
  ];
  const dateRange = GCLib.computeDateRange("year", { year: 2026 });
  const result = GCLib.filterFiles(files, { type: "all", search: "", dateRange });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, "1");
});

// --- sorting & missing sizes --------------------------------------------

test("sortFiles name-asc is case-insensitive alphabetical", () => {
  const files = [{ name: "banana" }, { name: "Apple" }, { name: "cherry" }];
  const sorted = GCLib.sortFiles(files, "name-asc").map((f) => f.name);
  assert.deepStrictEqual(sorted, ["Apple", "banana", "cherry"]);
});

test("sortFiles oldest/newest order by modifiedTime", () => {
  const files = [
    { name: "a", modifiedTime: "2026-01-01T00:00:00Z" },
    { name: "b", modifiedTime: "2020-01-01T00:00:00Z" },
  ];
  assert.deepStrictEqual(GCLib.sortFiles(files, "oldest").map((f) => f.name), ["b", "a"]);
  assert.deepStrictEqual(GCLib.sortFiles(files, "newest").map((f) => f.name), ["a", "b"]);
});

test("sortFiles largest handles missing sizes explicitly (sorted to the end)", () => {
  const files = [
    { name: "no-size-doc" }, // Google Docs/folders have no `size` field at all
    { name: "big", size: "5000" },
    { name: "small", size: "10" },
    { name: "null-size", size: null },
  ];
  const sorted = GCLib.sortFiles(files, "largest").map((f) => f.name);
  assert.deepStrictEqual(sorted, ["big", "small", "no-size-doc", "null-size"]);
});

test("summarizeSize sums known sizes and counts unknowns separately", () => {
  const files = [{ size: "100" }, { size: "200" }, {}, { size: null }, { size: "not-a-number" }];
  const summary = GCLib.summarizeSize(files);
  assert.strictEqual(summary.totalBytes, 300);
  assert.strictEqual(summary.unknownCount, 3);
});

test("formatBytes produces human-readable units", () => {
  assert.strictEqual(GCLib.formatBytes(0), "0 B");
  assert.strictEqual(GCLib.formatBytes(500), "500 B");
  assert.strictEqual(GCLib.formatBytes(1536), "1.5 KB");
  assert.strictEqual(GCLib.formatBytes(5 * 1024 * 1024), "5.0 MB");
});

// --- job persistence / retry state transitions (pure reducer logic) -----

test("createJob snapshots items as pending", () => {
  const job = GCLib.createJob({ id: "job1", account: "a@example.com", items: [{ id: "f1", name: "One" }, { id: "f2", name: "Two" }] });
  assert.strictEqual(job.status, "processing");
  assert.strictEqual(job.items.length, 2);
  assert.ok(job.items.every((it) => it.status === "pending"));
});

test("markItemResult transitions pending -> ok/failed and completes the job", () => {
  const job = GCLib.createJob({ id: "job1", account: "a@example.com", items: [{ id: "f1", name: "One" }, { id: "f2", name: "Two" }] });
  GCLib.markItemResult(job, "f1", true);
  assert.strictEqual(GCLib.nextPendingItem(job).id, "f2");
  assert.strictEqual(job.status, "processing");
  GCLib.markItemResult(job, "f2", false, "rate limited");
  assert.strictEqual(job.status, "done");
  const counts = GCLib.jobCounts(job);
  assert.deepStrictEqual(counts, { pending: 0, ok: 1, failed: 1 });
});

test("resetFailedItems re-queues only failed items and reopens the job", () => {
  const job = GCLib.createJob({ id: "job1", account: "a@example.com", items: [{ id: "f1", name: "One" }, { id: "f2", name: "Two" }] });
  GCLib.markItemResult(job, "f1", true);
  GCLib.markItemResult(job, "f2", false, "boom");
  assert.strictEqual(job.status, "done");
  GCLib.resetFailedItems(job);
  assert.strictEqual(job.status, "processing");
  assert.strictEqual(GCLib.nextPendingItem(job).id, "f2");
});

test("isJobActive is true only while processing or paused for reauth", () => {
  const job = GCLib.createJob({ id: "job1", account: "a@example.com", items: [{ id: "f1", name: "One" }] });
  assert.strictEqual(GCLib.isJobActive(job), true);
  job.status = "paused_reauth";
  assert.strictEqual(GCLib.isJobActive(job), true);
  job.status = "done";
  assert.strictEqual(GCLib.isJobActive(job), false);
  assert.strictEqual(GCLib.isJobActive(null), false);
});

test("backoffDelayMs grows and is capped", () => {
  const d0 = GCLib.backoffDelayMs(0, 100, 1000);
  const d5 = GCLib.backoffDelayMs(5, 100, 1000);
  assert.ok(d0 >= 100 && d0 < 100 + 250);
  assert.ok(d5 >= 1000 && d5 < 1000 + 250); // capped at max + jitter
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
