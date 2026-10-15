"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function worker({ failPopup = false } = {}) {
  let listener;
  let opened = 0;
  let signedIn = false;
  const noopEvent = { addListener() {} };
  const context = {
    importScripts() {},
    GCAuth: { configured: () => true, getToken: async () => { signedIn = true; return "session-token"; }, isSigningIn: () => false },
    GCLib: { isJobActive: () => false },
    chrome: {
      action: { openPopup: async () => { assert.equal(signedIn, true); opened++; if (failPopup) throw new Error("Popup unavailable"); } },
      storage: { local: { get: async () => ({}) } },
      alarms: { onAlarm: noopEvent },
      runtime: { id: "extension-id", onStartup: noopEvent, onInstalled: noopEvent, onMessage: { addListener(fn) { listener = fn; } } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return {
    opened: () => opened,
    dispatch: message => new Promise(resolve => listener(message, { id: "extension-id" }, resolve)),
  };
}

test("interactive Google sign-in returns to the extension after tokens are ready", async () => {
  const w = worker();
  const result = await w.dispatch({ type: "authenticate", interactive: true, chooseAccount: true });
  assert.equal(result.ok, true);
  assert.equal(result.token, "session-token");
  assert.equal(w.opened(), 1);
});

test("silent session restoration does not reopen a popup", async () => {
  const w = worker();
  assert.equal((await w.dispatch({ type: "authenticate", interactive: false })).ok, true);
  assert.equal(w.opened(), 0);
});

test("Chrome popup restrictions do not discard a successful sign-in", async () => {
  const w = worker({ failPopup: true });
  const result = await w.dispatch({ type: "authenticate", interactive: true });
  assert.equal(result.ok, true);
  assert.equal(result.token, "session-token");
});
