"use strict";
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

class AuthError extends Error {}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;

function config() {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_EXTENSION_ID: extensionId, SESSION_ENCRYPTION_KEY } = process.env;
  const key = Buffer.from(SESSION_ENCRYPTION_KEY || "", "base64");
  if (!clientId || !clientSecret || !/^[a-p]{32}$/.test(extensionId || "") || key.length !== 32) {
    throw new AuthError("Authentication service is not configured.");
  }
  return { clientId, clientSecret, extensionId, key, redirectUri: `https://${extensionId}.chromiumapp.org/` };
}

function prepare(req, res, method, settings) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const origin = `chrome-extension://${settings.extensionId}`;
  // Privileged extension requests can omit Origin. Accept an explicit ID
  // in that case; neither this header nor Origin is an OAuth credential.
  // Codes still require PKCE and refresh handles require authenticated decryption.
  const identifiedExtension = !req.headers.origin && req.headers["x-googlecleaner-extension"] === settings.extensionId;
  if (req.headers.origin !== origin && !identifiedExtension) {
    res.status(403).json({ error: "This endpoint is only available to the configured extension." });
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin, X-GoogleCleaner-Extension");
  res.setHeader("Access-Control-Allow-Methods", `${method}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-GoogleCleaner-Extension");
  if (req.method === "OPTIONS") { res.status(204).end(); return false; }
  if (req.method !== method) { res.setHeader("Allow", method); res.status(405).json({ error: "Method not allowed." }); return false; }
  return true;
}

function sealSession(refreshToken, settings) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", settings.key, iv);
  cipher.setAAD(Buffer.from(settings.clientId));
  const payload = JSON.stringify({ refreshToken, expiresAt: Date.now() + SESSION_LIFETIME });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function openSession(session, settings) {
  if (typeof session !== "string" || session.length > 8192) throw new AuthError("Invalid session. Sign in again.");
  try {
    const data = Buffer.from(session, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", settings.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(settings.clientId));
    decipher.setAuthTag(data.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
    if (typeof payload.refreshToken !== "string" || !payload.refreshToken || payload.expiresAt <= Date.now()) throw new AuthError();
    return payload.refreshToken;
  } catch (_) { throw new AuthError("Session expired or invalid. Sign in again."); }
}

async function exchange(body, settings, request = fetch) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthError("Invalid authentication request.");
  const params = new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret });
  let refreshToken;
  if (body.grantType === "authorization_code") {
    if (typeof body.code !== "string" || !body.code || body.code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier || "")) {
      throw new AuthError("Invalid authorization code or verifier.");
    }
    params.set("grant_type", "authorization_code");
    params.set("code", body.code);
    params.set("code_verifier", body.codeVerifier);
    params.set("redirect_uri", settings.redirectUri);
  } else if (body.grantType === "refresh_token") {
    refreshToken = openSession(body.session, settings);
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
  } else { throw new AuthError("Unsupported grant type."); }
  const response = await request("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params,
    signal: AbortSignal.timeout(10000),
  });
  const tokens = await response.json();
  if (!response.ok) throw new AuthError("Google could not authorize this session. Check OAuth setup or sign in again.");
  if (typeof tokens.access_token !== "string" || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new AuthError("Google returned an incomplete authorization response.");
  }
  if (tokens.scope && !tokens.scope.split(" ").includes(DRIVE_SCOPE)) throw new AuthError("Google Drive access was not granted. Sign in again and approve Drive access.");
  refreshToken = tokens.refresh_token || refreshToken;
  return { accessToken: tokens.access_token, expiresIn: tokens.expires_in, session: refreshToken ? sealSession(refreshToken, settings) : null };
}
module.exports = { AuthError, DRIVE_SCOPE, config, prepare, sealSession, openSession, exchange };
