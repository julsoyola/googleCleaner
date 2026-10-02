# GoogleCleaner (personal-use Chrome extension)

A Manifest V3, plain-JS extension to review your own Google Drive files and
move selected items to Trash. No build step, no framework, no third-party
servers. It never permanently deletes files, never empties Trash, and only
acts on items you explicitly select.

## 1. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder in this repo.
4. The card for "GoogleCleaner" appears with an **ID** such as
   `abcdefghijklmnopqrstuvwxyzabcdef`.

## 2. Stabilize the extension ID (recommended before creating the OAuth client)

An unpacked extension's ID is derived from its path unless you pin it with a
fixed key. If you skip this, the ID can change if you move/reload the folder,
which would break the OAuth client's "Item ID" later. To pin it:

```bash
cd extension
openssl genrsa -out key.pem 2048
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Copy the base64 output and add it to `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "GoogleCleaner",
  "key": "PASTE_THE_BASE64_STRING_HERE",
  ...
}
```

Reload the extension in `chrome://extensions` (the refresh icon on the card).
The ID shown on the card is now stable. Keep `key.pem` private and out of
git (it is not needed by Chrome at runtime, only to regenerate the same ID).

## 3. Create a Chrome Extension OAuth client in your Google Cloud project

1. In your existing Google Cloud project, open **APIs & Services → Library**
   and make sure **Google Drive API** is enabled.
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
3. Application type: **Chrome Extension**.
4. Item ID: paste the extension ID from step 1 or 2.
5. Click **Create** and copy the generated **Client ID**
   (ends with `.apps.googleusercontent.com`).

## 4. Configure the client ID

Open `extension/manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive"]
}
```

Save the file, then reload the extension in `chrome://extensions`. The
"Connect Google Drive" button is disabled and a warning banner is shown
until a real client ID (not the placeholder string) is present.

## 5. Add your Google account as a test user

If the OAuth consent screen for this project is in **Testing** mode:

1. Go to **APIs & Services → OAuth consent screen → Audience** (or
   **Test users**, depending on the console version).
2. Add your own Google account email as a test user.
3. Save.

Without this, sign-in will be blocked with an "access blocked" error for
any account that isn't the project owner or a listed test user.

## 6. Test before bulk use

1. In Google Drive, create a disposable test file (e.g. a blank Google Doc)
   and a disposable test folder containing one file.
2. Open the extension popup, click **Connect Google Drive**, and approve
   access. Confirm the signed-in email shown matches your account.
3. Search for the test file/folder, select them, click **Move selected to
   Trash**, and confirm in the dialog.
4. Verify in Google Drive that only the test items (and the folder's
   contents, as warned) moved to Trash — not your real files.
5. Only after this check succeeds, use the tool on real files.

## 7. Test that cleanup jobs survive closing the popup

The bulk-trash job runs in the background service worker (`background.js`),
not in the popup, so closing the popup does not cancel it. To verify this:

1. Select several disposable test files (more than a couple, so the job
   takes a few seconds) and click **Move to Trash**, then confirm.
2. Immediately close the popup (click elsewhere on the page, or press the
   keyboard shortcut to close extension popups).
3. Wait a few seconds, then click the GoogleCleaner toolbar icon again to
   reopen the popup.
4. You should see the job's progress (or "Done" summary) already reflected,
   even though the popup was closed while it was running.
5. In `chrome://extensions`, you can also click "service worker" under
   GoogleCleaner's "Inspect views" to watch `background.js` logs/console
   while the popup is closed, confirming it keeps running independently.
6. To test recovery after the service worker itself is suspended: in
   `chrome://extensions`, use the "service worker" inspect link, and in that
   DevTools window run `chrome.runtime.reload()` is too disruptive — instead
   just wait; Chrome suspends idle service workers automatically after
   ~30 seconds, and the 1-minute `chrome.alarms` tick in `background.js`
   will wake it up and resume any unfinished job from its last checkpoint.

## Notes on scopes and data handling

- The extension uses `chrome.identity.getAuthToken` with the
  `https://www.googleapis.com/auth/drive` scope, which is required to list
  and trash files you own (the narrower `drive.file` scope only covers files
  the app itself created or opened, not your existing files).
- The signed-in account's email is read from the Drive API's `about`
  endpoint (`fields=user(emailAddress)`), so no separate profile/userinfo
  scope is requested.
- `storage` and `alarms` permissions were added so the bulk-trash job can
  persist in `chrome.storage.local` and resume via `chrome.alarms` after the
  popup closes or the service worker is suspended. No other permissions
  were added (e.g. no `tabs` permission — "Open in Drive" uses a plain link).
- No client secret is embedded (Chrome Extension OAuth clients don't use one).
- Auth tokens are never logged; only error messages are shown in the UI.
- Expired/revoked tokens are detected on 401 responses, the cached token is
  dropped, and the user is prompted to sign in again once.
