"use strict";

// GoogleCleaner background service worker (Manifest V3).
// Owns the persistent bulk-trash job so it survives popup close and SW
// suspension. State lives in chrome.storage.local; chrome.alarms provides
// the wake-up/checkpoint mechanism instead of relying on an in-memory loop.

importScripts("lib.js", "auth-config.js", "auth.js");

const DRIVE_API = "https://www.googleapis.com/drive/v3/";
const JOB_KEY = "cleanupJob";
const ALARM_NAME = "gc-cleanup-tick";
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

let runningInMemory = false;
let jobOperations = Promise.resolve();
let accountSwitchPending = false;

// Serialize state changes and request dispatch, but never hold this lock
// while a Drive mutation is in flight.
function withJobLock(operation) {
  const result = jobOperations.then(operation);
  jobOperations = result.catch(() => {});
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJob() {
  const data = await chrome.storage.local.get(JOB_KEY);
  return data[JOB_KEY] || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function clearJob() {
  await chrome.storage.local.remove(JOB_KEY);
}

function getAuthToken(interactive) {
  if (GCAuth.configured()) return GCAuth.getToken(interactive);
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        reject(new Error(err ? err.message : "No auth token returned."));
        return;
      }
      resolve(token);
    });
  });
}

async function fetchAccountEmail(token) {
  const res = await fetch(`${DRIVE_API}about?fields=user(emailAddress)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 401 && GCAuth.configured()) await GCAuth.invalidate();
    const e = new Error(`Could not verify account (status ${res.status}).`);
    if (res.status === 401) e.authExpired = true;
    throw e;
  }
  const data = await res.json();
  return (data.user && data.user.emailAddress) || null;
}

async function trashFileWithRetry(token, jobId, id) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dispatched = await withJobLock(async () => {
      const current = await getJob();
      if (!current || current.id !== jobId || current.status !== "processing") return null;
      return { response: fetch(`${DRIVE_API}files/${encodeURIComponent(id)}?fields=id,trashed`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // Operates on the item's own id only; never resolves shortcut targets.
        body: JSON.stringify({ trashed: true }),
      }) };
    });
    if (!dispatched) return false;
    const res = await dispatched.response;

    if (res.ok) return true;

    if (res.status === 401) {
      if (GCAuth.configured()) await GCAuth.invalidate();
      const e = new Error("Authorization expired or was revoked.");
      e.authExpired = true;
      throw e;
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
      await sleep(GCLib.backoffDelayMs(attempt));
      continue;
    }

    let detail = "";
    try {
      const body = await res.json();
      detail = (body.error && body.error.message) || "";
    } catch (_) {
      // ignore unparsable error body
    }
    throw new Error(`Drive API ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  throw new Error("Exceeded retry attempts.");
}

async function pauseForReauth(job, message) {
  await withJobLock(async () => {
    const current = await getJob();
    if (!current || current.id !== job.id || current.status !== "processing") return;
    current.status = "paused_reauth";
    current.reauthMessage = message || "Authorization expired or was revoked. Resume to continue.";
    current.updatedAt = Date.now();
    await saveJob(current);
  });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}

async function clearAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

async function processJob() {
  if (runningInMemory) return;
  runningInMemory = true;
  try {
    let job = await getJob();
    if (!GCLib.isJobActive(job) || job.status !== "processing") return;

    let token;
    try {
      token = await getAuthToken(false); // non-interactive: never prompt from the background
    } catch (err) {
      await pauseForReauth(job);
      return;
    }

    let email;
    try {
      email = await fetchAccountEmail(token);
    } catch (err) {
      await pauseForReauth(job);
      return;
    }

    if (email !== job.account) {
      // Never resume a job under a different signed-in account.
      await pauseForReauth(
        job,
        `Signed-in account changed to ${email || "another account"}. Reconnect with ${job.account} to continue, or dismiss this job.`
      );
      return;
    }

    let item = GCLib.nextPendingItem(job);
    while (item) {
      let error = null;
      try {
        if (!await trashFileWithRetry(token, job.id, item.id)) return;
      } catch (err) {
        if (err.authExpired) {
          await pauseForReauth(job);
          return;
        }
        error = err.message;
      }
      job = await withJobLock(async () => {
        const current = await getJob();
        if (!current || current.id !== job.id) return null;
        const status = current.status;
        GCLib.markItemResult(current, item.id, error === null, error);
        // An already-dispatched request may finish after Disconnect.
        // Record its result without overwriting the user's pause.
        if (status === "paused_disconnected") current.status = status;
        await saveJob(current);
        if (current.status === "done") await clearAlarm();
        return current;
      });
      if (!job || job.status !== "processing") return;
      item = GCLib.nextPendingItem(job);
    }
    await clearAlarm();
  } finally {
    runningInMemory = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    processJob();
  }
});

// Resume on browser restart / extension reload if a job was left active.
chrome.runtime.onStartup.addListener(() => withJobLock(async () => {
  const job = await getJob();
  if (job && job.status === "paused_disconnected") {
    await clearAlarm();
  } else if (GCLib.isJobActive(job)) {
    await ensureAlarm();
    if (job.status === "processing") processJob();
  }
}));

chrome.runtime.onInstalled.addListener(() => withJobLock(async () => {
  const job = await getJob();
  if (job && job.status === "paused_disconnected") {
    await clearAlarm();
  } else if (GCLib.isJobActive(job)) {
    await ensureAlarm();
    if (job.status === "processing") processJob();
  }
}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (_sender.id !== chrome.runtime.id) return false;
  // Interactive sign-in must not hold the cleanup-job lock while a user
  // chooses an account. Stored session state survives popup closure.
  if (message && ["authenticate", "clearAuth", "invalidateAuth"].includes(message.type)) {
    (async () => {
      if (message.type === "authenticate") {
        if (message.chooseAccount) {
          await withJobLock(async () => {
            const job = await getJob();
            if (GCLib.isJobActive(job)) throw new Error("Finish the current cleanup job before switching accounts.");
            if (accountSwitchPending) throw new Error("An account switch is already in progress.");
            accountSwitchPending = true;
          });
        }
        try {
          const token = await GCAuth.getToken(Boolean(message.interactive), Boolean(message.chooseAccount));
          return { ok: true, token };
        } finally {
          if (message.chooseAccount) accountSwitchPending = false;
        }
      }
      if (message.type === "clearAuth") await GCAuth.clear();
      else await GCAuth.invalidate();
      return { ok: true };
    })().then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  withJobLock(async () => {
    switch (message && message.type) {
      case "startJob": {
        if (accountSwitchPending || (GCAuth.configured() && GCAuth.isSigningIn())) {
          sendResponse({ ok: false, error: "Finish Google sign-in before starting a cleanup job." });
          return;
        }
        const existing = await getJob();
        if (GCLib.isJobActive(existing)) {
          sendResponse({ ok: false, error: "A cleanup job is already running. Finish, retry, or dismiss it first." });
          return;
        }
        const job = GCLib.createJob({
          id: crypto.randomUUID(),
          account: message.account,
          items: message.items || [],
        });
        await saveJob(job);
        await ensureAlarm();
        sendResponse({ ok: true, job });
        processJob();
        break;
      }
      case "disconnectJob": {
        const job = await getJob();
        if (GCLib.isJobActive(job)) {
          job.status = "paused_disconnected";
          job.reauthMessage = null;
          job.updatedAt = Date.now();
          await saveJob(job);
        }
        await clearAlarm();
        sendResponse({ ok: true });
        break;
      }
      case "getJob": {
        const job = await getJob();
        sendResponse({ ok: true, job });
        break;
      }
      case "retryFailed": {
        const job = await getJob();
        if (!job) {
          sendResponse({ ok: false, error: "No job found." });
          return;
        }
        if (job.status === "paused_disconnected") {
          sendResponse({ ok: false, error: "Resume the disconnected job before retrying failures." });
          return;
        }
        GCLib.resetFailedItems(job);
        await saveJob(job);
        await ensureAlarm();
        sendResponse({ ok: true, job });
        processJob();
        break;
      }
      case "resumeJob": {
        const job = await getJob();
        if (!job) {
          sendResponse({ ok: false, error: "No job found." });
          return;
        }
        if (runningInMemory) {
          sendResponse({ ok: false, error: "A request is still finishing. Try Resume again shortly." });
          return;
        }
        const token = await getAuthToken(false);
        const email = await fetchAccountEmail(token);
        if (email !== job.account) {
          sendResponse({ ok: false, error: `Sign in with ${job.account} to resume this job.` });
          return;
        }
        job.status = GCLib.nextPendingItem(job) ? "processing" : "done";
        job.reauthMessage = null;
        await saveJob(job);
        if (job.status === "processing") await ensureAlarm();
        else await clearAlarm();
        sendResponse({ ok: true, job });
        processJob();
        break;
      }
      case "dismissJob": {
        const job = await getJob();
        if (job && GCLib.isJobActive(job)) {
          sendResponse({ ok: false, error: "Cannot dismiss a job that is still running." });
          return;
        }
        await clearJob();
        await clearAlarm();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  }).catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});
