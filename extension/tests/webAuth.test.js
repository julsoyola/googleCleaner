"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const REDIRECT = "https://acijddppbcekpnlddndfomahlpgcnfoe.chromiumapp.org/";

function worker() {
  const storage = {};
  const requests = [];
  let launch;
  const context = {
    GC_AUTH_CONFIG: { authOrigin: "https://auth.example.test" }, URL, URLSearchParams, TextEncoder, Uint8Array, AbortSignal, crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    chrome: {
      storage: { session: { get: async key => ({ [key]: storage[key] }), set: async data => Object.assign(storage, data), remove: async key => { delete storage[key]; } } },
      identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow: async options => launch(options) },
    },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      requests.push({ url, body });
      const value = url.endsWith("/config") ? { clientId: "web-client", redirectUri: REDIRECT, scope: "https://www.googleapis.com/auth/drive" }
        : { accessToken: body.grantType === "refresh_token" ? "refreshed-token" : "second-account-token", expiresIn: 3600, session: "sealed-refresh" };
      return { ok: true, json: async () => value };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../auth.js"), "utf8"), context);
  launch = async options => {
    const url = new URL(options.url);
    assert.equal(options.interactive, true);
    assert.equal(url.searchParams.get("prompt"), "select_account consent");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(REDIRECT);
    callback.search = new URLSearchParams({ code: "authorization-code", state: url.searchParams.get("state") }).toString();
    return callback.href;
  };
  return { auth: context.GCAuth, context, storage, requests, setLaunch: fn => { launch = fn; } };
}

test("web flow requests account selection and exchanges a PKCE-bound code", async () => {
  const w = worker();
  assert.equal(await w.auth.getToken(true, true), "second-account-token");
  const exchange = w.requests.find(request => request.body);
  assert.equal(exchange.body.grantType, "authorization_code");
  assert.equal(exchange.body.codeVerifier.length, 43);
  assert.equal(await w.auth.getToken(false), "second-account-token");
  assert.equal(w.requests.length, 2);
});

test("wrong state or redirect is rejected before exchanging a code", async () => {
  for (const returned of [REDIRECT + "?code=x&state=wrong", "https://other.invalid/?code=x&state=wrong"]) {
    const w = worker(); w.setLaunch(async () => returned);
    await assert.rejects(w.auth.getToken(true, true), /did not match/);
    assert.equal(w.requests.length, 1);
    assert.equal(Object.keys(w.storage).length, 0);
  }
});

test("cancellation preserves the previous account session", async () => {
  const w = worker();
  await w.auth.getToken(true);
  w.setLaunch(async () => { throw new Error("User canceled sign-in"); });
  await assert.rejects(w.auth.getToken(true, true), /canceled/);
  assert.equal(await w.auth.getToken(false), "second-account-token");
});

test("expired access token refreshes without opening a login window", async () => {
  const w = worker(); await w.auth.getToken(true);
  await w.auth.invalidate();
  w.setLaunch(async () => { throw new Error("Must not open a login window"); });
  assert.equal(await w.auth.getToken(false), "refreshed-token");
});

test("disconnect during login prevents a late session from being saved", async () => {
  const w = worker();
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  w.setLaunch(options => new Promise(resolve => {
    const url = new URL(options.url);
    finish = () => resolve(REDIRECT + "?code=x&state=" + url.searchParams.get("state"));
    started();
  }));
  const pending = w.auth.getToken(true, true);
  await ready;
  await w.auth.clear(); finish();
  await assert.rejects(pending, /canceled/);
  assert.equal(Object.keys(w.storage).length, 0);
});

test("missing session never prompts from background cleanup", async () => {
  const w = worker();
  await assert.rejects(w.auth.getToken(false), /Connect Google Drive/);
  assert.equal(w.requests.length, 0);
});
