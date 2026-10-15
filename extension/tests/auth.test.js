"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function popup() {
  const nodes = new Map();
  const timers = new Map();
  let callback;
  const context = {
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { textContent: "", disabled: false, classList: { add() {}, remove() {} }, setAttribute() {} });
        return nodes.get(id);
      },
      addEventListener() {},
    },
    chrome: {
      runtime: { getManifest: () => ({ oauth2: { client_id: "configured" } }), lastError: null },
      identity: { getAuthToken(_options, done) { callback = done; } },
    },
    setTimeout(fn, delay) { timers.set(fn, delay); return fn; },
    clearTimeout(id) { timers.delete(id); },
    AbortSignal,
    Map, Set, URLSearchParams,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8"), context);
  return { context, nodes, timers, respond: token => callback(token), evaluate: code => vm.runInContext(code, context) };
}

test("stalled sign-in restores the button and ignores a late token", async () => {
  const p = popup();
  const connecting = p.evaluate("connect()");
  assert.equal(p.nodes.get("connectBtn").disabled, true);
  const [timeout, delay] = [...p.timers][0];
  assert.equal(delay, 10000);
  timeout();
  await connecting;
  assert.equal(p.nodes.get("connectBtn").disabled, false);
  assert.equal(p.nodes.get("connectBtn").textContent, "Connect Google Drive");
  assert.match(p.nodes.get("errorBanner").textContent, /Google sign-in did not finish/);
  p.respond("late-test-token");
  await Promise.resolve();
  assert.equal(p.evaluate("state.token"), null);
});

test("successful auth clears its timeout and returns the token", async () => {
  const p = popup();
  const token = p.evaluate("getAuthToken(true)");
  p.respond("test-token");
  assert.equal(await token, "test-token");
  assert.equal(p.timers.size, 0);
});

test("Drive timeout restores the button with a network message", async () => {
  const p = popup();
  p.context.fetch = async (_url, options) => {
    assert(options.signal instanceof AbortSignal);
    const error = new Error("Timed out");
    error.name = "TimeoutError";
    throw error;
  };
  const connecting = p.evaluate("connect()");
  p.respond("test-token");
  await connecting;
  assert.equal(p.nodes.get("connectBtn").disabled, false);
  assert.match(p.nodes.get("errorBanner").textContent, /Google Drive did not respond/);
});

test("synchronous identity errors clear the timeout and restore the button", async () => {
  const p = popup();
  p.context.chrome.identity.getAuthToken = () => { throw new Error("Identity unavailable"); };
  await p.evaluate("connect()");
  assert.equal(p.timers.size, 0);
  assert.equal(p.nodes.get("connectBtn").disabled, false);
  assert.match(p.nodes.get("errorBanner").textContent, /Identity unavailable/);
});

test("switch launches Google authentication directly without creating an app window", async () => {
  const p = popup();
  p.context.GCLib = { isJobActive: () => false };
  p.context.chrome.runtime.sendMessage = async () => ({ ok: true, job: null });
  p.evaluate("connect = async options => { globalThis.switchRequested = options.chooseAccount; }");
  await p.evaluate("switchAccount()");
  assert.equal(p.context.switchRequested, true);
  assert.equal(p.timers.size, 0);
});

test("active jobs block switching before authentication", async () => {
  const p = popup();
  p.context.GCLib = { isJobActive: () => true };
  p.context.chrome.runtime.sendMessage = async () => ({ ok: true, job: { status: "processing" } });
  await p.evaluate("switchAccount()");
  assert.match(p.nodes.get("errorBanner").textContent, /cleanup job is running/);
});

test("unconfigured chooser shows setup instructions without clearing selections", async () => {
  const p = popup();
  p.context.GCLib = { isJobActive: () => false };
  p.context.chrome.runtime.sendMessage = async () => ({ ok: true, job: null });
  p.evaluate("state.selectedIds.add('old-account-file')");
  await p.evaluate("switchAccount()");
  assert.equal(p.evaluate("state.selectedIds.size"), 1);
  assert.equal(p.nodes.get("connectBtn").disabled, false);
  assert.match(p.nodes.get("errorBanner").textContent, /Vercel account chooser/);
});

test("failed job lookup cannot bypass the switching safeguard", async () => {
  const p = popup();
  p.context.chrome.runtime.sendMessage = async () => ({ ok: false });
  await p.evaluate("switchAccount()");
  assert.equal(p.nodes.get("connectBtn").disabled, false);
  assert.match(p.nodes.get("errorBanner").textContent, /Could not check the current cleanup job/);
});

test("switch commits the new account without carrying old selections or files", async () => {
  const p = popup();
  p.context.GCLib = { isJobActive: () => false };
  p.context.chrome.runtime.sendMessage = async () => ({ ok: true, job: null });
  p.context.GC_AUTH_CONFIG = { authOrigin: "https://auth.example.test" };
  p.context.chrome.runtime.sendMessage = async message => message.type === "authenticate"
    ? { ok: true, token: "new-account-token" } : { ok: true, job: null };
  p.context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: { emailAddress: "second@example.test" } }) });
  p.evaluate(`
    state.email = 'first@example.test';
    state.files = [{ id: 'old-file' }];
    state.selectedIds.add('old-file');
    loadFiles = async () => {};
    refreshJobView = async () => {};
  `);
  await p.evaluate("switchAccount()");
  assert.equal(p.evaluate("state.email"), "second@example.test");
  assert.equal(p.evaluate("state.token"), "new-account-token");
  assert.equal(p.evaluate("state.selectedIds.size"), 0);
  assert.equal(p.evaluate("state.files.length"), 0);
});

test("a different account session clears stale windows and selections", () => {
  const p = popup();
  p.evaluate("state.token = 'old-token'; state.email = 'first@example.test'; state.selectedIds.add('old-file')");
  p.context.change = { googleCleanerAuthSession: { oldValue: { sessionId: "old" }, newValue: { sessionId: "new" } } };
  p.evaluate("handleAuthSessionChange(change, 'session')");
  assert.equal(p.evaluate("state.token"), null);
  assert.equal(p.evaluate("state.selectedIds.size"), 0);
  assert.match(p.nodes.get("errorBanner").textContent, /another window/);
});

test("refreshing the same account session preserves the current UI", () => {
  const p = popup();
  p.evaluate("state.token = 'existing-token'");
  p.context.change = { googleCleanerAuthSession: { oldValue: { sessionId: "same" }, newValue: { sessionId: "same" } } };
  p.evaluate("handleAuthSessionChange(change, 'session')");
  assert.equal(p.evaluate("state.token"), "existing-token");
});

test("popup restores a cached account without interactive sign-in", async () => {
  const p = popup();
  p.context.GC_AUTH_CONFIG = { authOrigin: "https://auth.example.test" };
  p.context.chrome.runtime.sendMessage = async message => {
    assert.equal(message.interactive, false);
    return { ok: true, token: "cached-token" };
  };
  p.evaluate(`fetchAccountEmail = async () => 'cached@example.test'; loadFiles = async () => {}; refreshJobView = async () => {};`);
  await p.evaluate("restoreSession()");
  assert.equal(p.evaluate("state.token"), "cached-token");
  assert.equal(p.evaluate("state.email"), "cached@example.test");
  assert.equal(p.nodes.get("connectBtn").disabled, false);
});

test("popup with no session stays signed out without opening Google", async () => {
  const p = popup();
  p.context.GC_AUTH_CONFIG = { authOrigin: "https://auth.example.test" };
  p.context.chrome.runtime.sendMessage = async message => {
    assert.equal(message.interactive, false);
    return { ok: false, error: "Connect Google Drive" };
  };
  await p.evaluate("restoreSession()");
  assert.equal(p.evaluate("state.token"), null);
  assert.equal(p.nodes.get("connectBtn").disabled, false);
});
