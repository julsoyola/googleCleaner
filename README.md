# GoogleCleaner

A personal Chrome extension for reviewing your own Google Drive files and moving selected items to Trash.

<img src="docs/images/googlecleaner-preview.png" alt="GoogleCleaner connect screen" width="480">

*Connect screen, shown before signing in with Google.*

<img src="docs/images/googlecleaner-review.png" alt="GoogleCleaner file list with search, filters, and selection" width="480">

*File list with search, type/date/sort filters, and selection before review.*

## Features

- Sign in with your own Google account via `chrome.identity`
- Browse your Drive files with search, file-type filter, last-modified filter, and sorting
- Select individual files or folders, review the selection, then move them to Trash
- Background cleanup job with progress and retry, so closing the popup doesn't cancel it

## Install locally

The extension is [available on the Chrome Web Store](https://chromewebstore.google.com/detail/googlecleaner/acijddppbcekpnlddndfomahlpgcnfoe).
To test local code changes, load an unpacked copy:

1. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** the `extension/` folder.
2. Follow [`extension/README.md`](extension/README.md) to set up your own Chrome Extension OAuth client and configure it in `extension/manifest.json`.

## Switch accounts

The account chooser uses a small Vercel auth service. Follow
[`auth-backend/README.md`](auth-backend/README.md) to configure its
Google Web OAuth client and Vercel environment variables.

After setup, open the account menu → **Switch account** →
**Continue with Google**. The app-styled window opens Google's own
account chooser. One account is active at a time; old selections are
cleared on successful sign-in. Active cleanup jobs block switching.

Until configured, ordinary Chrome-profile sign-in still works, while
Switch account explains the required setup. Web Store publication and
Google OAuth access are separate settings; Testing-mode OAuth apps
only allow configured test users.

## How cleanup works

Selecting items and confirming **Move to Trash** moves only those explicitly selected items to Google Drive's Trash — the same as Drive's own "Remove" action. Nothing is permanently deleted and Trash is never emptied by this tool.

See [`privacy.html`](privacy.html) for the privacy policy.

