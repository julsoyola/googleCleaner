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
  sort: "name-asc",
  dateFilter: "any",
  dateExtra: {},
};

const el = {
  closeBtn: document.getElementById("closeBtn"),
  avatarInitial: document.getElementById("avatarInitial"),
  accountEmail: document.getElementById("accountEmail"),
  signOutBtn: document.getElementById("signOutBtn"),
  configWarning: document.getElementById("configWarning"),
  errorBanner: document.getElementById("errorBanner"),
  connectSection: document.getElementById("connectSection"),
  connectBtn: document.getElementById("connectBtn"),
  appBody: document.getElementById("appBody"),
  bottomNav: document.getElementById("bottomNav"),
  selectionBar: document.getElementById("selectionBar"),
  filterTypeSelect: document.getElementById("filterTypeSelect"),
  searchInput: document.getElementById("searchInput"),
  refreshBtn: document.getElementById("refreshBtn"),
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
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  reviewSelectedBtn: document.getElementById("reviewSelectedBtn"),
  selectedCount: document.getElementById("selectedCount"),
  trashBtn: document.getElementById("trashBtn"),
  listStatus: document.getElementById("listStatus"),
  hiddenSelectedInfo: document.getElementById("hiddenSelectedInfo"),
  storageSummary: document.getElementById("storageSummary"),
  fileList: document.getElementById("fileList"),
  jobSection: document.getElementById("jobSection"),
  noActivityText: document.getElementById("noActivityText"),
  jobStatusText: document.getElementById("jobStatusText"),
  jobProgressBar: document.getElementById("jobProgressBar"),
  jobReauthNotice: document.getElementById("jobReauthNotice"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  jobResultList: document.getElementById("jobResultList"),
  retryFailedBtn: document.getElementById("retryFailedBtn"),
  dismissJobBtn: document.getElementById("dismissJobBtn"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmText: document.getElementById("confirmText"),
  confirmSizeText: document.getElementById("confirmSizeText"),
  confirmFolderWarning: document.getElementById("confirmFolderWarning"),
  confirmCancelBtn: document.getElementById("confirmCancelBtn"),
  confirmOkBtn: document.getElementById("confirmOkBtn"),
  reviewCount: document.getElementById("reviewCount"),
  reviewList: document.getElementById("reviewList"),
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
  "application/vnd.google-apps.folder": "Google Drive",
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
  const filtered = getFilteredFiles();
  const selectedFiles = Array.from(state.selectedIds)
    .map((id) => state.filesById.get(id))
    .filter(Boolean);
  const { totalBytes, unknownCount } = GCLib.summarizeSize(selectedFiles);

  let text = `${filtered.length} matching \u00b7 ${selectedFiles.length} selected \u00b7 ~${GCLib.formatBytes(totalBytes)} reported size`;
  if (unknownCount > 0) {
    text += ` (${unknownCount} selected item${unknownCount === 1 ? "" : "s"} have no reported size)`;
  }
  text += ". Folder contents aren't included, and this is not a guaranteed amount of space recovered.";
  el.storageSummary.textContent = text;
  el.storageSummary.classList.remove("hidden");
}

function updateHiddenSelectedInfo() {
  const filteredIds = new Set(getFilteredFiles().map((f) => f.id));
  const hiddenCount = Array.from(state.selectedIds).filter((id) => !filteredIds.has(id)).length;
  if (hiddenCount > 0) {
    el.hiddenSelectedInfo.textContent = `${hiddenCount} selected item${hiddenCount === 1 ? "" : "s"} hidden by current filters. Use Review selected to see them.`;
    el.hiddenSelectedInfo.classList.remove("hidden");
  } else {
    el.hiddenSelectedInfo.classList.add("hidden");
  }
}

// --- rendering ------------------------------------------------------------

function closeAllFileMenus() {
  document.querySelectorAll(".file-menu").forEach((m) => m.remove());
}

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
  meta.textContent = `${TYPE_LABEL[file.mimeType] || "File"} \u00b7 Modified ${formatModified(file.modifiedTime)}`;

  main.append(name, meta);

  const menuWrap = document.createElement("span");
  menuWrap.className = "file-menu-wrap";

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "file-menu-btn";
  menuBtn.setAttribute("aria-label", `More actions for ${file.name}`);
  menuBtn.setAttribute("aria-haspopup", "true");
  menuBtn.textContent = "\u22EF";
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const alreadyOpen = menuWrap.querySelector(".file-menu");
    closeAllFileMenus();
    if (alreadyOpen) return; // toggle: clicking again just closes it
    const menu = document.createElement("span");
    menu.className = "file-menu";
    menu.setAttribute("role", "menu");
    if (file.webViewLink) {
      const link = document.createElement("a");
      link.href = file.webViewLink;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open in Drive";
      link.setAttribute("role", "menuitem");
      link.setAttribute("aria-label", `Open ${file.name} in Drive`);
      menu.appendChild(link);
    }
    menuWrap.appendChild(menu);
  });

  menuWrap.appendChild(menuBtn);

  li.append(checkbox, typeIcon, main, menuWrap);

  // Clicking the row toggles the checkbox once; the checkbox, the overflow
  // menu button, and menu items are excluded so none double-toggles or is
  // swallowed, and opening the menu / opening Drive never changes selection.
  li.addEventListener("click", (event) => {
    if (event.target === checkbox || event.target.closest(".file-menu-wrap")) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event("change"));
  });

  return li;
}

function renderFileList() {
  const filtered = getFilteredFiles();
  el.fileList.textContent = "";
  closeAllFileMenus();

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

  setStatus(filtered.length === 0 ? "No files match the current filters." : `${filtered.length} of ${state.files.length} files shown`);
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = state.selectedIds.size;
  el.selectedCount.textContent = `${count} selected`;
  el.clearSelectionBtn.disabled = count === 0;
  el.reviewSelectedBtn.disabled = count === 0;

  const filtered = getFilteredFiles();
  el.selectAllMatching.disabled = filtered.length === 0;

  updateStorageSummary();
  updateHiddenSelectedInfo();
  updateTrashButtonState();
}

async function updateTrashButtonState() {
  const job = await getCurrentJob();
  el.trashBtn.disabled = state.selectedIds.size === 0 || GCLib.isJobActive(job);
}

function getCurrentJob() {
  return sendMessage({ type: "getJob" }).then((resp) => (resp && resp.job) || null);
}

// --- review selected dialog -----------------------------------------------

function renderReviewList() {
  const ids = Array.from(state.selectedIds);
  el.reviewCount.textContent = `${ids.length} item${ids.length === 1 ? "" : "s"} selected`;
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
}

function openReview() {
  switchTab("tabSelected");
}

// --- job rendering ----------------------------------------------------

function renderJob(job) {
  el.noActivityText.classList.toggle("hidden", !!job);
  if (!job) {
    el.jobSection.classList.add("hidden");
    updateTrashButtonState();
    return;
  }

  el.jobSection.classList.remove("hidden");
  const counts = GCLib.jobCounts(job);
  const total = job.items.length;
  const done = counts.ok + counts.failed;

  el.jobProgressBar.max = total;
  el.jobProgressBar.value = done;

  if (job.status === "processing") {
    el.jobStatusText.textContent = `Trashing items for ${job.account}: ${done} of ${total} processed (${counts.ok} moved, ${counts.failed} failed so far).`;
  } else if (job.status === "paused_reauth") {
    el.jobStatusText.textContent = `Paused: ${done} of ${total} processed.`;
  } else if (job.status === "done") {
    el.jobStatusText.textContent = `Done for ${job.account}: ${counts.ok} moved to Trash, ${counts.failed} failed.`;
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

  updateTrashButtonState();
}

async function refreshJobView() {
  const job = await getCurrentJob();
  renderJob(job);
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
    el.accountEmail.textContent = state.email;
    el.avatarInitial.textContent = (state.email[0] || "?").toUpperCase();
    el.signOutBtn.classList.remove("hidden");
    el.connectSection.classList.add("hidden");
    el.appBody.classList.remove("hidden");
    el.bottomNav.classList.remove("hidden");
    el.selectionBar.classList.remove("hidden");
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

async function signOut() {
  clearError();
  if (state.token) {
    await removeCachedToken(state.token);
  }
  state.token = null;
  state.email = null;
  state.files = [];
  state.filesById = new Map();
  state.selectedIds.clear();
  el.signOutBtn.classList.add("hidden");
  el.appBody.classList.add("hidden");
  el.bottomNav.classList.add("hidden");
  el.selectionBar.classList.add("hidden");
  el.connectSection.classList.remove("hidden");
  el.connectBtn.disabled = false;
  el.connectBtn.textContent = "Connect Google Drive";
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
  el.trashBtn.focus();
}

async function startTrashJob() {
  closeConfirm();
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

// --- bottom nav tabs ---------------------------------------------------

function switchTab(tabId, { focusTab = false } = {}) {
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("hidden", panel.id !== tabId);
  }
  let activeBtn = null;
  for (const btn of el.bottomNav.querySelectorAll(".nav-btn")) {
    const isActive = btn.dataset.tab === tabId;
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? 0 : -1;
    if (isActive) activeBtn = btn;
  }
  if (focusTab && activeBtn) activeBtn.focus();
  if (tabId === "tabSelected") renderReviewList();
}

function focusAdjacentTab(delta) {
  const tabs = Array.from(el.bottomNav.querySelectorAll(".nav-btn"));
  const current = tabs.findIndex((btn) => btn.getAttribute("aria-selected") === "true");
  const next = (current + delta + tabs.length) % tabs.length;
  switchTab(tabs[next].dataset.tab, { focusTab: true });
}

// --- wiring ------------------------------------------------------------

function init() {
  if (isPlaceholderClientId()) {
    el.configWarning.classList.remove("hidden");
    el.connectBtn.disabled = true;
  }

  el.closeBtn.addEventListener("click", () => window.close());
  el.signOutBtn.addEventListener("click", signOut);

  el.connectBtn.addEventListener("click", connect);
  el.refreshBtn.addEventListener("click", loadFiles);

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
    // Only items matching every active filter (type + search + date).
    getFilteredFiles().forEach((f) => state.selectedIds.add(f.id));
    renderFileList();
    renderReviewList();
  });

  el.clearSelectionBtn.addEventListener("click", () => {
    state.selectedIds.clear();
    renderFileList();
    renderReviewList();
  });

  el.reviewSelectedBtn.addEventListener("click", openReview);

  for (const btn of el.bottomNav.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

  el.bottomNav.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAdjacentTab(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAdjacentTab(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      switchTab(el.bottomNav.querySelector(".nav-btn").dataset.tab, { focusTab: true });
    } else if (event.key === "End") {
      event.preventDefault();
      const tabs = el.bottomNav.querySelectorAll(".nav-btn");
      switchTab(tabs[tabs.length - 1].dataset.tab, { focusTab: true });
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".file-menu-wrap")) closeAllFileMenus();
  });

  el.trashBtn.addEventListener("click", async () => {
    const job = await getCurrentJob();
    if (GCLib.isJobActive(job)) {
      showError("A cleanup job is already running. Finish, retry, or dismiss it first.");
      return;
    }
    openConfirm();
  });
  el.confirmCancelBtn.addEventListener("click", closeConfirm);
  el.confirmOkBtn.addEventListener("click", startTrashJob);

  el.retryFailedBtn.addEventListener("click", retryFailed);
  el.dismissJobBtn.addEventListener("click", dismissJob);
  el.reconnectBtn.addEventListener("click", reconnectJob);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!el.confirmOverlay.classList.contains("hidden")) closeConfirm();
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
