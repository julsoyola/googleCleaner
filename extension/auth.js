"use strict";
// Runs only in the service worker. No Google passwords or client secrets here.
globalThis.GCAuth = (() => {
  const KEY = "googleCleanerAuthSession";
  let authentication;
  let refresh;
  let generation = 0;
  let sessionOperations = Promise.resolve();
  function withSessionLock(operation) {
    const pending = sessionOperations.then(operation);
    sessionOperations = pending.catch(() => {});
    return pending;
  }
  const configured = () => Boolean(GC_AUTH_CONFIG.authOrigin);
  function origin() {
    const url = new URL(GC_AUTH_CONFIG.authOrigin);
    if (url.protocol !== "https:" || url.origin !== GC_AUTH_CONFIG.authOrigin) throw new Error("Set an HTTPS auth origin in auth-config.js.");
    return url.origin;
  }
  async function request(path, body) {
    let response;
    try {
      response = await fetch(origin() + path, {
        method: body ? "POST" : "GET", headers: {
          "Content-Type": "application/json",
          "X-GoogleCleaner-Extension": chrome.runtime.id,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (error.name === "TimeoutError") throw new Error("Authentication service did not respond within 10 seconds. Try again.");
      throw error;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Authentication service is unavailable.");
    return data;
  }
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  function save(tokens, version, sessionId) {
    return withSessionLock(async () => {
      if (version !== generation) throw new Error("Sign-in was canceled. Try again.");
      if (!tokens.accessToken || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) throw new Error("Invalid authentication response.");
      const session = { accessToken: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000, session: tokens.session || null, sessionId };
      await chrome.storage.session.set({ [KEY]: session });
      return session.accessToken;
    });
  }
  async function signIn() {
    const version = generation;
    const settings = await request("/api/config");
    const redirect = chrome.identity.getRedirectURL();
    if (settings.redirectUri !== redirect || settings.scope !== "https://www.googleapis.com/auth/drive" || !settings.clientId) {
      throw new Error("Auth backend and extension settings do not match.");
    }
    const state = random();
    const verifier = random();
    const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: redirect,
      response_type: "code", scope: settings.scope, state, code_challenge: challenge,
      code_challenge_method: "S256", access_type: "offline", prompt: "select_account consent" }).toString();
    const returned = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    if (!returned) throw new Error("Sign-in was canceled.");
    const callback = new URL(returned);
    const expected = new URL(redirect);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.get("state") !== state) {
      throw new Error("Google sign-in response did not match this request.");
    }
    if (callback.searchParams.has("error")) throw new Error("Google sign-in was canceled or access was denied.");
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Google did not return an authorization code.");
    return save(await request("/api/token", { grantType: "authorization_code", code, codeVerifier: verifier }), version, random());
  }
  async function getToken(interactive, chooseAccount = false) {
    if (!configured()) throw new Error("Account chooser is not configured. Follow auth-backend/README.md.");
    if (authentication) {
      if (interactive) throw new Error("A Google sign-in window is already open. Finish or close it first.");
      throw new Error("Google sign-in is in progress. Resume cleanup after signing in.");
    }
    if (!chooseAccount) {
      await sessionOperations;
      const data = (await chrome.storage.session.get(KEY))[KEY];
      if (data && data.expiresAt > Date.now() + 60000) return data.accessToken;
      if (data && data.session) {
        if (!refresh) {
          const version = generation;
          refresh = request("/api/token", { grantType: "refresh_token", session: data.session })
            .then(tokens => save(tokens, version, data.sessionId)).finally(() => { refresh = null; });
        }
        // Do not silently switch accounts when a session expires or is revoked.
        try { return await refresh; }
        catch (error) { if (!interactive) throw error; }
      }
    }
    if (!interactive) throw new Error("Connect Google Drive to authorize this session.");
    generation++;
    authentication = signIn();
    try { return await authentication; } finally { authentication = null; }
  }
  function clear() { generation++; return withSessionLock(() => chrome.storage.session.remove(KEY)); }
  async function invalidate() {
    generation++;
    await withSessionLock(async () => {
      const data = (await chrome.storage.session.get(KEY))[KEY];
      if (data) await chrome.storage.session.set({ [KEY]: { ...data, accessToken: null, expiresAt: 0 } });
    });
  }
  return { configured, getToken, clear, invalidate, isSigningIn: () => Boolean(authentication) };
})();
