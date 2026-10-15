"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomBytes } = require("node:crypto");
const { config, prepare, sealSession, openSession, exchange, DRIVE_SCOPE } = require("../lib/oauth");
const settings = { clientId: "test-client", clientSecret: "server-only-secret", extensionId: "a".repeat(32), redirectUri: `https://${"a".repeat(32)}.chromiumapp.org/`, key: randomBytes(32) };

test("refresh handles are encrypted, authenticated and tied to the client", () => {
  const session = sealSession("private-refresh-token", settings);
  assert(!Buffer.from(session, "base64url").toString().includes("private-refresh-token"));
  assert.equal(openSession(session, settings), "private-refresh-token");
  const corrupt = Buffer.from(session, "base64url"); corrupt[30] ^= 1;
  assert.throws(() => openSession(corrupt.toString("base64url"), settings), /invalid/);
  assert.throws(() => openSession(session, { ...settings, clientId: "other-client" }), /invalid/);
});

test("expired handles fail closed", () => {
  const original = Date.now;
  const session = sealSession("refresh-token", settings);
  Date.now = () => original() + 8 * 86400000;
  try { assert.throws(() => openSession(session, settings), /expired/); }
  finally { Date.now = original; }
});

test("code exchange uses fixed redirect, PKCE and server secret", async () => {
  const result = await exchange({ grantType: "authorization_code", code: "one-use-code", codeVerifier: "x".repeat(43), redirectUri: "https://attacker.invalid/" }, settings, async (url, options) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(options.body.get("client_secret"), settings.clientSecret);
    assert.equal(options.body.get("redirect_uri"), settings.redirectUri);
    assert.equal(options.body.get("code_verifier"), "x".repeat(43));
    return { ok: true, json: async () => ({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: DRIVE_SCOPE }) };
  });
  assert.equal(result.accessToken, "access");
  assert.equal(openSession(result.session, settings), "refresh");
  assert(!JSON.stringify(result).includes(settings.clientSecret));
});

test("refresh uses the sealed handle and preserves authorization", async () => {
  const session = sealSession("original-refresh", settings);
  const result = await exchange({ grantType: "refresh_token", session }, settings, async (_url, options) => {
    assert.equal(options.body.get("refresh_token"), "original-refresh");
    return { ok: true, json: async () => ({ access_token: "renewed-access", expires_in: 3600 }) };
  });
  assert.equal(result.accessToken, "renewed-access");
  assert.equal(openSession(result.session, settings), "original-refresh");
});

test("invalid grants and missing Drive consent cannot issue a session", async () => {
  await assert.rejects(exchange({ grantType: "authorization_code", code: "code", codeVerifier: "short" }, settings), /verifier/);
  await assert.rejects(exchange({ grantType: "password" }, settings), /Unsupported/);
  await assert.rejects(exchange({ grantType: "authorization_code", code: "code", codeVerifier: "a".repeat(43) }, settings,
    async () => ({ ok: true, json: async () => ({ access_token: "access", expires_in: 3600, scope: "openid" }) })), /Drive access/);
});

test("CORS limits the service to the configured extension", () => {
  const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; }, end() {} });
  const denied = response();
  assert.equal(prepare({ method: "POST", headers: { origin: "https://other.invalid" } }, denied, "POST", settings), false);
  assert.equal(denied.code, 403);
  const preflight = response();
  assert.equal(prepare({ method: "OPTIONS", headers: { origin: `chrome-extension://${settings.extensionId}` } }, preflight, "POST", settings), false);
  assert.equal(preflight.code, 204);
  assert.equal(preflight.headers["Cache-Control"], "no-store");
});

test("config endpoint never returns the server secret", () => {
  const previous = { ...process.env };
  Object.assign(process.env, { GOOGLE_CLIENT_ID: settings.clientId, GOOGLE_CLIENT_SECRET: settings.clientSecret, GOOGLE_EXTENSION_ID: settings.extensionId, SESSION_ENCRYPTION_KEY: settings.key.toString("base64") });
  try {
    assert.equal(config().redirectUri, settings.redirectUri);
    const res = { setHeader() {}, status() { return this; }, json(body) { this.body = body; } };
    require("../api/config")({ method: "GET", headers: { origin: `chrome-extension://${settings.extensionId}` } }, res);
    assert.equal(res.body.clientId, settings.clientId);
    assert(!JSON.stringify(res.body).includes(settings.clientSecret));
  } finally {
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_EXTENSION_ID", "SESSION_ENCRYPTION_KEY"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("privileged extension requests without Origin use the explicit extension ID", () => {
  for (const method of ["GET", "POST"]) {
    const res = { setHeader() {}, status() { return this; }, json() { assert.fail("matching extension request rejected"); } };
    assert.equal(prepare({ method, headers: { "x-googlecleaner-extension": settings.extensionId } }, res, method, settings), true);
  }
});

test("missing identity, wrong extension ID and conflicting origins stay rejected", () => {
  for (const headers of [{}, { "x-googlecleaner-extension": "b".repeat(32) }, { origin: "https://other.invalid", "x-googlecleaner-extension": settings.extensionId }]) {
    const res = { setHeader() {}, status(code) { assert.equal(code, 403); return this; }, json() {} };
    assert.equal(prepare({ method: "GET", headers }, res, "GET", settings), false);
  }
});
