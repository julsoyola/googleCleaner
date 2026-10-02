"use strict";

// GoogleCleaner background service worker (Manifest V3).
// Owns the persistent bulk-trash job so it survives popup close and SW
// suspension. State lives in chrome.storage.local; chrome.alarms provides
// the wake-up/checkpoint mechanism instead of relying on an in-memory loop.

importScripts("lib.js");

const DRIVE_API = "https://www.googleapis.com/drive/v3/";
const JOB_KEY = "cleanupJob";
const ALARM_NAME = "gc-cleanup-tick";
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

let runningInMemory = false;

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
    const e = new Error(`Could not verify account (status ${res.status}).`);
    if (res.status === 401) e.authExpired = true;
    throw e;
  }
  const data = await res.json();
  return (data.user && data.user.emailAddress) || null;
}

async function trashFileWithRetry(token, id) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${DRIVE_API}files/${encodeURIComponent(id)}?fields=id,trashed`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Operates on the item's own id only; never resolves shortcut targets.
      body: JSON.stringify({ trashed: true }),
    });

    if (res.ok) return;

    if (res.status === 401) {
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
  job.status = "paused_reauth";
  job.reauthMessage = message || "Authorization expired or was revoked. Reconnect to continue.";
  job.updatedAt = Date.now();
  await saveJob(job);
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
      try {
        await trashFileWithRetry(token, item.id);
        GCLib.markItemResult(job, item.id, true);
      } catch (err) {
        if (err.authExpired) {
          await pauseForReauth(job);
          return;
        }
        GCLib.markItemResult(job, item.id, false, err.message);
      }
      await saveJob(job); // checkpoint after every single item
      item = GCLib.nextPendingItem(job);
    }

    await saveJob(job);
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
chrome.runtime.onStartup.addListener(async () => {
  const job = await getJob();
  if (GCLib.isJobActive(job)) {
    await ensureAlarm();
    if (job.status === "processing") processJob();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const job = await getJob();
  if (GCLib.isJobActive(job)) {
    await ensureAlarm();
    if (job.status === "processing") processJob();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message && message.type) {
      case "startJob": {
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
        job.status = "processing";
        job.reauthMessage = null;
        await saveJob(job);
        await ensureAlarm();
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
  })();
  return true; // keep the message channel open for the async response
});
