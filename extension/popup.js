"use strict";

// GoogleCleaner popup logic. Plain JS, no build step, no framework.
// Scopes/API: chrome.identity.getAuthToken + Google Drive API v3 directly.
// Bulk trash jobs run in background.js (service worker); this file only
// renders job state and sends control messages to it.

const DRIVE_API = "https://www.googleapis.com/drive/v3/";

const state = {
  token: null,
  email: null,
  files: [],
  filesById: new Map(),
  selectedIds: new Set(),
  filter: "all",
  search: "",
  sort: "oldest",
  dateFilter: "any",
  dateExtra: {},
};

const el = {
  configWarning: document.getElementById("configWarning"),
  errorBanner: document.getElementById("errorBanner"),
  connectSection: document.getElementById("connectSection"),
  connectBtn: document.getElementById("connectBtn"),
  appBody: document.getElementById("appBody"),
  accountMenuBtn: document.getElementById("accountMenuBtn"),
  accountEmail: document.getElementById("accountEmail"),
  accountMenu: document.getElementById("accountMenu"),
  switchAccountBtn: document.getElementById("switchAccountBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  searchInput: document.getElementById("searchInput"),
  filterTypeSelect: document.getElementById("filterTypeSelect"),
  dateFilterSelect: document.getElementById("dateFilterSelect"),
  dateMonthControls: document.getElementById("dateMonthControls"),
  dateMonthInput: document.getElementById("dateMonthInput"),
  dateYearControls: document.getElementById("dateYearControls"),
  dateYearInput: document.getElementById("dateYearInput"),
  dateRangeControls: document.getElementById("dateRangeControls"),
  dateFromInput: document.getElementById("dateFromInput"),
  dateToInput: document.getElementById("dateToInput"),
  dateRangeError: document.getElementById("dateRangeError"),
  sortSelect: document.getElementById("sortSelect"),
  selectAllMatching: document.getElementById("selectAllMatching"),
  matchingCount: document.getElementById("matchingCount"),
  listStatus: document.getElementById("listStatus"),
  hiddenSelectedInfo: document.getElementById("hiddenSelectedInfo"),
  storageSummary: document.getElementById("storageSummary"),
  fileList: document.getElementById("fileList"),
  jobBar: document.getElementById("jobBar"),
  jobDetailsToggle: document.getElementById("jobDetailsToggle"),
  jobDetails: document.getElementById("jobDetails"),
  jobStatusText: document.getElementById("jobStatusText"),
  jobProgressBar: document.getElementById("jobProgressBar"),
  jobReauthNotice: document.getElementById("jobReauthNotice"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  jobResultList: document.getElementById("jobResultList"),
  retryFailedBtn: document.getElementById("retryFailedBtn"),
  dismissJobBtn: document.getElementById("dismissJobBtn"),
  bottomBar: document.getElementById("bottomBar"),
  selectedCount: document.getElementById("selectedCount"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  reviewSelectedBtn: document.getElementById("reviewSelectedBtn"),
  reviewOverlay: document.getElementById("reviewOverlay"),
  reviewAccountText: document.getElementById("reviewAccountText"),
  reviewSizeText: document.getElementById("reviewSizeText"),
  reviewFolderWarning: document.getElementById("reviewFolderWarning"),
  reviewList: document.getElementById("reviewList"),
  reviewCloseBtn: document.getElementById("reviewCloseBtn"),
  reviewTrashBtn: document.getElementById("reviewTrashBtn"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmText: document.getElementById("confirmText"),
  confirmSizeText: document.getElementById("confirmSizeText"),
  confirmFolderWarning: document.getElementById("confirmFolderWarning"),
  confirmCancelBtn: document.getElementById("confirmCancelBtn"),
  confirmOkBtn: document.getElementById("confirmOkBtn"),
};

const TYPE_ICON = {
  "application/vnd.google-apps.document": "\uD83D\uDCC4",
  "application/vnd.google-apps.spreadsheet": "\uD83D\uDCCA",
  "application/vnd.google-apps.presentation": "\uD83D\uDDBC",
  "application/vnd.google-apps.folder": "\uD83D\uDCC1",
  "application/vnd.google-apps.shortcut": "\u2197",
  "application/pdf": "\uD83D\uDCD5",
};

const TYPE_LABEL = {
  "application/vnd.google-apps.document": "Google Docs",
  "application/vnd.google-apps.spreadsheet": "Google Sheets",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.shortcut": "Shortcut",
  "application/pdf": "PDF",
};

function formatModified(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isPlaceholderClientId() {
  const clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id || "";
  return clientId.includes("YOUR_CHROME_EXTENSION_OAUTH_CLIENT_ID");
}

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.classList.remove("hidden");
}

function clearError() {
  el.errorBanner.textContent = "";
  el.errorBanner.classList.add("hidden");
}

function setStatus(message) {
  if (!message) {
    el.listStatus.classList.add("hidden");
    el.listStatus.textContent = "";
    return;
  }
  el.listStatus.textContent = message;
  el.listStatus.classList.remove("hidden");
}

// --- auth helpers -----------------------------------------------------

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

function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

function clearAllCachedTokens() {
  return new Promise((resolve) => {
    if (!chrome.identity.clearAllCachedAuthTokens) {
      resolve();
      return;
    }
    chrome.identity.clearAllCachedAuthTokens(() => resolve());
  });
}

function isUserCancelled(err) {
  const msg = (err && err.message || "").toLowerCase();
  return msg.includes("did not approve") || msg.includes("cancel");
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

// --- Drive API helpers --------------------------------------------------

async function driveFetch(pathAndQuery, options = {}, allowRetry = true) {
  const res = await fetch(DRIVE_API + pathAndQuery, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${state.token}`,
    },
  });

  if (res.status === 401 && allowRetry) {
    // Token expired or revoked: drop cache and re-request interactively once.
    await removeCachedToken(state.token);
    state.token = await getAuthToken(true);
    return driveFetch(pathAndQuery, options, false);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body.error && body.error.message) || "";
    } catch (_) {
      // ignore body parse failures
    }
    throw new Error(`Drive API ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  return res.json();
}

async function fetchAccountEmail() {
  const about = await driveFetch("about?fields=user(emailAddress,displayName)");
  return (about.user && about.user.emailAddress) || "unknown account";
}

async function fetchAllOwnedFiles() {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: "trashed = false and 'me' in owners",
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size,webViewLink)",
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveFetch(`files?${params.toString()}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// --- filtering, sorting, summaries ---------------------------------------

function getDateRange() {
  return GCLib.computeDateRange(state.dateFilter, state.dateExtra);
}

function getFilteredFiles() {
  const dateRange = getDateRange();
  const filtered = GCLib.filterFiles(state.files, {
    type: state.filter,
    search: state.search,
    dateRange,
  });
  return GCLib.sortFiles(filtered, state.sort);
}

function updateDateRangeError() {
  const range = getDateRange();
  if (range && range.error) {
    const messages = {
      "missing-month": "Pick a month and year.",
      "missing-year": "Pick a year.",
      "missing-range": "Pick both a From and To date.",
      "invalid-range": "The From date must be on or before the To date.",
    };
    el.dateRangeError.textContent = messages[range.error] || "Invalid date filter.";
    el.dateRangeError.classList.remove("hidden");
    return true;
  }
  el.dateRangeError.classList.add("hidden");
  el.dateRangeError.textContent = "";
  return false;
}

function updateStorageSummary() {
  const selectedFiles = Array.from(state.selectedIds)
    .map((id) => state.filesById.get(id))
    .filter(Boolean);
  const { totalBytes, unknownCount } = GCLib.summarizeSize(selectedFiles);

  if (selectedFiles.length === 0) {
    el.storageSummary.classList.add("hidden");
    return;
  }
  let text = `~${GCLib.formatBytes(totalBytes)} reported size for selected items`;
  if (unknownCount > 0) {
    text += ` (${unknownCount} with no reported size)`;
  }
  text += ". Folder contents aren't included; not a guaranteed amount recovered.";
  el.storageSummary.textContent = text;
  el.storageSummary.classList.remove("hidden");
}

function updateHiddenSelectedInfo() {
  const filteredIds = new Set(getFilteredFiles().map((f) => f.id));
  const hiddenCount = Array.from(state.selectedIds).filter((id) => !filteredIds.has(id)).length;
  if (hiddenCount > 0) {
    el.hiddenSelectedInfo.textContent = `${hiddenCount} selected item${hiddenCount === 1 ? "" : "s"} hidden by current filters.`;
    el.hiddenSelectedInfo.classList.remove("hidden");
  } else {
    el.hiddenSelectedInfo.classList.add("hidden");
  }
}

// --- rendering ------------------------------------------------------------

function buildFileRow(file, { onToggle }) {
  const li = document.createElement("li");
  li.classList.toggle("selected", state.selectedIds.has(file.id));

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selectedIds.has(file.id);
  checkbox.setAttribute("aria-label", `Select ${file.name}`);
  checkbox.addEventListener("change", () => {
    li.classList.toggle("selected", checkbox.checked);
    onToggle(checkbox.checked);
  });

  const typeIcon = document.createElement("span");
  typeIcon.className = "file-type-icon";
  typeIcon.setAttribute("aria-hidden", "true");
  typeIcon.textContent = TYPE_ICON[file.mimeType] || "\uD83D\uDCC4";

  const main = document.createElement("span");
  main.className = "file-main";

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = file.name; // text only, never HTML

  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = `${TYPE_LABEL[file.mimeType] || "File"} \u00b7 ${formatModified(file.modifiedTime)}`;

  main.append(name, meta);
  li.append(checkbox, typeIcon, main);

  if (file.webViewLink) {
    const link = document.createElement("a");
    link.className = "open-link";
    link.href = file.webViewLink;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "\u2197";
    link.setAttribute("aria-label", `Open ${file.name} in Drive`);
    li.appendChild(link);
  }

  // Clicking the row toggles the checkbox once; the checkbox and the
  // Open-in-Drive link are excluded so neither double-toggles nor changes selection.
  li.addEventListener("click", (event) => {
    if (event.target === checkbox || event.target.closest("a")) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event("change"));
  });

  return li;
}

function renderFileList() {
  const filtered = getFilteredFiles();
  el.fileList.textContent = "";

  for (const file of filtered) {
    const li = buildFileRow(file, {
      onToggle: (checked) => {
        if (checked) state.selectedIds.add(file.id);
        else state.selectedIds.delete(file.id);
        updateSelectedCount();
      },
    });
    el.fileList.appendChild(li);
  }

  el.matchingCount.textContent = `${filtered.length} file${filtered.length === 1 ? "" : "s"}`;
  setStatus(filtered.length === 0 ? "No files match the current filters." : "");
  updateSelectedCount();
}

function updateSelectAllMatchingState() {
  const filtered = getFilteredFiles();
  if (filtered.length === 0) {
    el.selectAllMatching.checked = false;
    el.selectAllMatching.indeterminate = false;
    el.selectAllMatching.disabled = true;
    return;
  }
  el.selectAllMatching.disabled = false;
  const selectedCountInFiltered = filtered.filter((f) => state.selectedIds.has(f.id)).length;
  if (selectedCountInFiltered === 0) {
    el.selectAllMatching.checked = false;
    el.selectAllMatching.indeterminate = false;
  } else if (selectedCountInFiltered === filtered.length) {
    el.selectAllMatching.checked = true;
    el.selectAllMatching.indeterminate = false;
  } else {
    el.selectAllMatching.checked = false;
    el.selectAllMatching.indeterminate = true;
  }
}

function updateSelectedCount() {
  const count = state.selectedIds.size;
  el.selectedCount.textContent = `${count} selected`;
  el.clearSelectionBtn.disabled = count === 0;
  el.reviewSelectedBtn.disabled = count === 0;
  el.reviewSelectedBtn.textContent = `Review (${count})`;

  updateSelectAllMatchingState();
  updateStorageSummary();
  updateHiddenSelectedInfo();
}

function getCurrentJob() {
  return sendMessage({ type: "getJob" }).then((resp) => (resp && resp.job) || null);
}

// --- review dialog -----------------------------------------------

function renderReviewList() {
  const ids = Array.from(state.selectedIds);
  const selectedFiles = ids.map((id) => state.filesById.get(id)).filter(Boolean);
  const { totalBytes, unknownCount } = GCLib.summarizeSize(selectedFiles);

  el.reviewAccountText.textContent =
    `Account: ${state.email}. ${ids.length} item${ids.length === 1 ? "" : "s"} selected.`;

  let sizeText = `Reported size: ~${GCLib.formatBytes(totalBytes)}`;
  if (unknownCount > 0) {
    sizeText += ` (${unknownCount} item${unknownCount === 1 ? "" : "s"} have no reported size and aren't counted)`;
  }
  el.reviewSizeText.textContent = sizeText;

  const hasFolder = selectedFiles.some((f) => f.mimeType === GCLib.MIME_BY_FILTER.folder);
  el.reviewFolderWarning.classList.toggle("hidden", !hasFolder);

  el.reviewList.textContent = "";
  for (const id of ids) {
    const file = state.filesById.get(id);
    if (!file) continue;
    const li = buildFileRow(file, {
      onToggle: (checked) => {
        if (!checked) state.selectedIds.delete(file.id);
        updateSelectedCount();
        renderFileList();
        renderReviewList();
      },
    });
    el.reviewList.appendChild(li);
  }
  el.reviewTrashBtn.disabled = ids.length === 0;
}

function openReview() {
  renderReviewList();
  el.reviewOverlay.classList.remove("hidden");
  el.reviewCloseBtn.focus();
}

function closeReview() {
  el.reviewOverlay.classList.add("hidden");
  el.reviewSelectedBtn.focus();
}

// --- job rendering ----------------------------------------------------

function renderJob(job) {
  if (!job) {
    el.jobBar.classList.add("hidden");
    return;
  }

  el.jobBar.classList.remove("hidden");
  const counts = GCLib.jobCounts(job);
  const total = job.items.length;
  const done = counts.ok + counts.failed;

  el.jobProgressBar.max = total;
  el.jobProgressBar.value = done;

  if (job.status === "processing") {
    el.jobStatusText.textContent = `Cleaning up: ${done} of ${total} processed`;
  } else if (job.status === "paused_reauth") {
    el.jobStatusText.textContent = `Paused: ${done} of ${total} processed`;
  } else if (job.status === "done") {
    el.jobStatusText.textContent = `Done: ${counts.ok} moved, ${counts.failed} failed`;
  }

  el.jobReauthNotice.classList.toggle("hidden", job.status !== "paused_reauth");
  if (job.status === "paused_reauth" && job.reauthMessage) {
    el.jobReauthNotice.firstChild.textContent = job.reauthMessage + " ";
  }

  el.jobResultList.textContent = "";
  for (const item of job.items) {
    if (item.status === "pending") continue;
    const li = document.createElement("li");
    li.className = item.status === "ok" ? "result-ok" : "result-fail";
    li.textContent = item.status === "ok" ? item.name : `${item.name} - ${item.error || "failed"}`;
    el.jobResultList.appendChild(li);
  }

  el.retryFailedBtn.classList.toggle("hidden", counts.failed === 0 || job.status === "processing");
  el.dismissJobBtn.classList.toggle("hidden", job.status !== "done");
}

async function refreshJobView() {
  const job = await getCurrentJob();
  renderJob(job);
}

function toggleJobDetails() {
  const expanded = el.jobDetailsToggle.getAttribute("aria-expanded") === "true";
  el.jobDetailsToggle.setAttribute("aria-expanded", String(!expanded));
  el.jobDetails.classList.toggle("hidden", expanded);
}

// --- flows ------------------------------------------------------------

async function loadFiles() {
  setStatus("Loading files...");
  try {
    state.files = await fetchAllOwnedFiles();
    state.filesById = new Map(state.files.map((f) => [f.id, f]));
    // Selections are intentionally preserved across reloads/filters.
    for (const id of Array.from(state.selectedIds)) {
      if (!state.filesById.has(id)) state.selectedIds.delete(id);
    }
    renderFileList();
  } catch (err) {
    setStatus("");
    showError(`Could not load files: ${err.message}`);
  }
}

function showConnectedUI() {
  el.accountEmail.textContent = state.email;
  el.connectSection.classList.add("hidden");
  el.appBody.classList.remove("hidden");
  el.bottomBar.classList.remove("hidden");
}

async function connect() {
  clearError();
  if (isPlaceholderClientId()) {
    showError("Configure a real OAuth client ID in manifest.json first.");
    return;
  }
  el.connectBtn.disabled = true;
  el.connectBtn.textContent = "Connecting...";
  try {
    state.token = await getAuthToken(true);
    state.email = await fetchAccountEmail();
    showConnectedUI();
    await loadFiles();
    await refreshJobView();
  } catch (err) {
    el.connectBtn.disabled = false;
    el.connectBtn.textContent = "Connect Google Drive";
    if (isUserCancelled(err)) {
      showError("Sign-in was canceled.");
    } else {
      showError(`Could not connect: ${err.message}`);
    }
  }
}

function resetToSignedOut() {
  state.token = null;
  state.email = null;
  state.files = [];
  state.filesById = new Map();
  state.selectedIds.clear();
  el.appBody.classList.add("hidden");
  el.bottomBar.classList.add("hidden");
  el.connectSection.classList.remove("hidden");
  el.connectBtn.disabled = false;
  el.connectBtn.textContent = "Connect Google Drive";
}

async function disconnect() {
  clearError();
  closeAccountMenu();
  if (state.token) {
    await removeCachedToken(state.token);
  }
  resetToSignedOut();
}

async function switchAccount() {
  clearError();
  closeAccountMenu();
  const job = await getCurrentJob();
  if (GCLib.isJobActive(job)) {
    showError("A cleanup job is running under the current account. Finish, retry, or dismiss it before switching accounts.");
    return;
  }
  // Genuinely re-prompts the Google account chooser: clears every cached
  // token for this extension, then requests a fresh interactive token.
  await clearAllCachedTokens();
  resetToSignedOut();
  await connect();
}

function openAccountMenu() {
  el.accountMenu.classList.remove("hidden");
  el.accountMenuBtn.setAttribute("aria-expanded", "true");
}

function closeAccountMenu() {
  el.accountMenu.classList.add("hidden");
  el.accountMenuBtn.setAttribute("aria-expanded", "false");
}

function openConfirmFromReview() {
  const count = state.selectedIds.size;
  if (count === 0) return;
  openConfirm();
}

function openConfirm() {
  const count = state.selectedIds.size;
  const selectedFiles = Array.from(state.selectedIds).map((id) => state.filesById.get(id)).filter(Boolean);
  const { totalBytes, unknownCount } = GCLib.summarizeSize(selectedFiles);

  el.confirmText.textContent =
    `Account: ${state.email}. ${count} item${count === 1 ? "" : "s"} will be moved to Trash.`;

  let sizeText = `Reported size: ~${GCLib.formatBytes(totalBytes)}`;
  if (unknownCount > 0) {
    sizeText += ` (${unknownCount} item${unknownCount === 1 ? "" : "s"} have no reported size and aren't counted)`;
  }
  el.confirmSizeText.textContent = sizeText;

  const hasFolder = selectedFiles.some((f) => f.mimeType === GCLib.MIME_BY_FILTER.folder);
  el.confirmFolderWarning.classList.toggle("hidden", !hasFolder);

  el.confirmOverlay.classList.remove("hidden");
  el.confirmCancelBtn.focus();
}

function closeConfirm() {
  el.confirmOverlay.classList.add("hidden");
  el.reviewSelectedBtn.focus();
}

async function startTrashJob() {
  closeConfirm();
  el.reviewOverlay.classList.add("hidden");
  // Snapshot the confirmed IDs now; later filter/selection changes in the
  // popup cannot alter a job already handed off to the background worker.
  const items = Array.from(state.selectedIds)
    .map((id) => state.filesById.get(id))
    .filter(Boolean)
    .map((f) => ({ id: f.id, name: f.name }));

  const resp = await sendMessage({ type: "startJob", account: state.email, items });
  if (!resp || !resp.ok) {
    showError((resp && resp.error) || "Could not start the cleanup job.");
    return;
  }
  state.selectedIds.clear();
  renderFileList();
  await refreshJobView();
}

async function retryFailed() {
  const resp = await sendMessage({ type: "retryFailed" });
  if (!resp || !resp.ok) {
    showError((resp && resp.error) || "Could not retry failed items.");
    return;
  }
  await refreshJobView();
}

async function dismissJob() {
  const resp = await sendMessage({ type: "dismissJob" });
  if (!resp || !resp.ok) {
    showError((resp && resp.error) || "Could not dismiss the job.");
    return;
  }
  await refreshJobView();
  await loadFiles();
}

async function reconnectJob() {
  clearError();
  try {
    const token = await getAuthToken(true);
    state.token = token;
    const email = await fetchAccountEmail();
    const job = await getCurrentJob();
    if (job && job.account && job.account !== email) {
      showError(`This job belongs to ${job.account}. Sign in with that account to resume, or dismiss the job.`);
      return;
    }
    const resp = await sendMessage({ type: "resumeJob" });
    if (!resp || !resp.ok) {
      showError((resp && resp.error) || "Could not resume the job.");
      return;
    }
    await refreshJobView();
  } catch (err) {
    if (isUserCancelled(err)) {
      showError("Reconnect was canceled.");
    } else {
      showError(`Could not reconnect: ${err.message}`);
    }
  }
}

// --- date filter UI --------------------------------------------------

function updateDateSubControls() {
  el.dateMonthControls.classList.toggle("hidden", state.dateFilter !== "month");
  el.dateYearControls.classList.toggle("hidden", state.dateFilter !== "year");
  el.dateRangeControls.classList.toggle("hidden", state.dateFilter !== "range");
}

function applyDateFilterAndRerender() {
  updateDateSubControls();
  const invalid = updateDateRangeError();
  if (!invalid) {
    renderFileList();
  } else {
    // Show the error but don't silently apply a broken/partial filter.
    el.fileList.textContent = "";
    setStatus("Fix the date filter above to see results.");
    updateSelectedCount();
  }
}

// --- wiring ------------------------------------------------------------

function init() {
  if (isPlaceholderClientId()) {
    el.configWarning.classList.remove("hidden");
    el.connectBtn.disabled = true;
  }

  el.connectBtn.addEventListener("click", connect);
  el.refreshBtn.addEventListener("click", loadFiles);

  el.accountMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (el.accountMenu.classList.contains("hidden")) openAccountMenu();
    else closeAccountMenu();
  });
  el.disconnectBtn.addEventListener("click", disconnect);
  el.switchAccountBtn.addEventListener("click", switchAccount);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".account-menu-wrap")) closeAccountMenu();
  });

  el.filterTypeSelect.addEventListener("change", () => {
    state.filter = el.filterTypeSelect.value;
    renderFileList();
  });

  el.searchInput.addEventListener("input", () => {
    state.search = el.searchInput.value;
    renderFileList();
  });

  el.dateFilterSelect.addEventListener("change", () => {
    state.dateFilter = el.dateFilterSelect.value;
    applyDateFilterAndRerender();
  });

  el.dateMonthInput.addEventListener("change", () => {
    const [y, m] = (el.dateMonthInput.value || "").split("-").map(Number);
    state.dateExtra = { year: y, month: m };
    applyDateFilterAndRerender();
  });

  el.dateYearInput.addEventListener("input", () => {
    const y = Number(el.dateYearInput.value);
    state.dateExtra = { year: y || undefined };
    applyDateFilterAndRerender();
  });

  el.dateFromInput.addEventListener("change", () => {
    state.dateExtra = { ...state.dateExtra, from: el.dateFromInput.value };
    applyDateFilterAndRerender();
  });

  el.dateToInput.addEventListener("change", () => {
    state.dateExtra = { ...state.dateExtra, to: el.dateToInput.value };
    applyDateFilterAndRerender();
  });

  el.sortSelect.addEventListener("change", () => {
    state.sort = el.sortSelect.value;
    renderFileList();
  });

  el.selectAllMatching.addEventListener("click", () => {
    // Only items matching every active filter (type + search + date);
    // unchecking deselects only matching items, preserving hidden selections.
    const filtered = getFilteredFiles();
    if (el.selectAllMatching.checked) {
      filtered.forEach((f) => state.selectedIds.add(f.id));
    } else {
      filtered.forEach((f) => state.selectedIds.delete(f.id));
    }
    renderFileList();
  });

  el.clearSelectionBtn.addEventListener("click", () => {
    state.selectedIds.clear();
    renderFileList();
  });

  el.reviewSelectedBtn.addEventListener("click", openReview);
  el.reviewCloseBtn.addEventListener("click", closeReview);
  el.reviewTrashBtn.addEventListener("click", openConfirmFromReview);

  el.jobDetailsToggle.addEventListener("click", toggleJobDetails);

  el.confirmCancelBtn.addEventListener("click", closeConfirm);
  el.confirmOkBtn.addEventListener("click", startTrashJob);

  el.retryFailedBtn.addEventListener("click", retryFailed);
  el.dismissJobBtn.addEventListener("click", dismissJob);
  el.reconnectBtn.addEventListener("click", reconnectJob);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el.confirmOverlay.classList.contains("hidden")) closeConfirm();
    else if (!el.reviewOverlay.classList.contains("hidden")) closeReview();
    else if (!el.accountMenu.classList.contains("hidden")) closeAccountMenu();
  });

  // Live updates while the popup is open, driven by the background job.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.cleanupJob) {
      renderJob(changes.cleanupJob.newValue || null);
    }
  });

  refreshJobView();
}

document.addEventListener("DOMContentLoaded", init);
