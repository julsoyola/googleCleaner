# googleCleaner

Personal-use tooling for managing a personal Google Drive account, plus the
static pages used to satisfy Google's OAuth consent screen requirements.

## What's in this repo

- **`extension/`** — GoogleCleaner, a Manifest V3 Chrome extension. It lets you
  sign in with `chrome.identity`, browse your own Google Drive files (search,
  filter by type/last-modified, sort), select items, review what's selected,
  and move them to Trash. Bulk trash jobs run in a background service worker
  so they persist even if the popup is closed, with retry and reconnect
  support if your sign-in expires.
- **`index.html`** / **`privacy.html`** — minimal homepage and privacy policy
  pages, published via GitHub Pages, used as the Homepage URL and Privacy
  Policy URL on Google's OAuth consent screen for this personal project.

## How GoogleCleaner works

1. You click **Connect Google Drive** in the extension popup, which triggers
   `chrome.identity.getAuthToken` for an OAuth token scoped to your own Drive
   files (no client secret is involved or stored — Chrome extension OAuth
   clients don't use one).
2. The extension lists your non-trashed, owned files directly from the
   Google Drive API (handling pagination), and lets you filter/sort/search
   and select items.
3. When you confirm **Move to Trash**, the selected file IDs are handed off
   to the extension's background service worker, which trashes them one by
   one (with retries on rate limits/transient errors), persisting progress
   so you can close the popup without losing the job.
4. Nothing is ever permanently deleted or has Trash emptied by this tool —
   it only moves explicitly selected items to Trash, the same as the normal
   "Remove" action in Google Drive's own UI.

## How to access / run it

GoogleCleaner is not published on the Chrome Web Store — it's meant to be
loaded locally as an unpacked extension by its owner:

1. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked**
   the `extension/` folder.
2. Follow the full setup steps in [`extension/README.md`](extension/README.md)
   to stabilize the extension ID, create your own Chrome Extension OAuth
   client in Google Cloud, and configure it in `extension/manifest.json`.
3. Test with a disposable file/folder before using it on real data.

No credentials, client secrets, or API keys are committed to this repo. The
OAuth client ID present in `extension/manifest.json` identifies the app to
Google's consent screen only — by itself it does not grant access to any
account.
