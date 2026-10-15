# GoogleCleaner account chooser

A Vercel Node.js service that exchanges Google authorization codes and
refreshes sessions. Google handles the login and account chooser.
Drive requests still go directly from the extension to Google.

## 1. Create the Vercel project

Import this GitHub repository into Vercel as a **new project**.
Use **Other** for the framework and `auth-backend` for Root Directory.
Leave build and output directory overrides empty. Use Node.js 22.
Choose a production domain and keep it stable.

The setup below must be completed before the chooser can work.
The new `auth-backend` files must be committed and pushed before Vercel
can import them from GitHub. This preparation does not publish them.
Keep Vercel Deployment Protection disabled for this production auth
service so extension requests reach its endpoints. Preview deployments
can remain protected. Do not use a changing preview URL in the extension.

## 2. Create Google OAuth credentials

In the existing Google Cloud project, enable Google Drive API.
Go to Google Auth Platform → Clients → Create client.
Choose **Web application**, rather than Chrome Extension.
Register this exact authorized redirect URI, including the final slash:

```text
https://acijddppbcekpnlddndfomahlpgcnfoe.chromiumapp.org/
```

Keep the existing Chrome Extension client for the unconfigured fallback.
The Web client ID and secret belong only in Vercel environment variables.
Do not paste the secret into the extension, GitHub, or chat.

In Audience, add both accounts as test users if the OAuth app is in
Testing mode. Public Web Store publication does not change OAuth
publishing or verification status. Add the Drive scope to Data Access.
Google may require verification before broader public access.

## 3. Set Vercel environment variables

Set these for the auth project's Production environment:

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | New Web application client ID |
| `GOOGLE_CLIENT_SECRET` | New Web application client secret |
| `GOOGLE_EXTENSION_ID` | `acijddppbcekpnlddndfomahlpgcnfoe` |
| `SESSION_ENCRYPTION_KEY` | A random 32-byte key encoded as base64 |

Generate the encryption key on your Mac:

```sh
openssl rand -base64 32
```

Save it directly in Vercel. Redeploy after setting the variables.
Rotating the key invalidates existing encrypted sessions.
The `.env.example` file lists the variable names without credentials.

## 4. Configure the unpacked extension

From the repository root, replace the example URL below with your real
Vercel production origin. Do not include a trailing slash.

```sh
node scripts/configure-auth.js https://YOUR-AUTH-HOST.vercel.app
```

The script updates `extension/auth-config.js` and adds permission for
that exact host in `extension/manifest.json`. Reload the unpacked
extension at `chrome://extensions` and reopen it.
Chrome 116 or newer is required for the interactive worker flow.

An empty auth origin preserves the original Chrome-profile sign-in.
Switch account reports a setup error until the new service is configured.

## 5. Verify in Chrome

1. Connect an account. Google should open its own account chooser.
2. In the account menu, choose Switch account. An app-styled window
   opens. Click Continue with Google and select your other account.
3. Confirm its email and files appear, with no old selections.
4. Cancel sign-in and verify it does not replace the existing session.
5. With a disposable file, verify review, cleanup, job recovery and
   Disconnect. Active jobs must block switching; jobs must never run
   under another account.
6. Close and reopen the popup. The session should still be usable.
   Restarting Chrome clears the session and requires reconnecting.

Do not assume mocked tests verify real Google consent, OAuth settings,
Vercel CORS responses, or Web Store publication.

## Session and network behavior

- The worker validates OAuth state and the exact extension redirect.
- PKCE binds each authorization code to its originating request.
- Only the Vercel service knows the Web client secret.
- Google tokens are never logged by this code. Do not enable request-body
  logging on the auth endpoints or capture their responses in analytics.
- Access tokens and an encrypted refresh handle stay in
  `chrome.storage.session`, available only during the browser session.
- The refresh handle is AES-256-GCM encrypted by Vercel and expires in
  seven days. The service has no database and does not persist tokens.
- The service receives authorization codes/verifiers and encrypted refresh
  handles, exchanges them with Google, and returns access tokens. It does
  not receive Drive metadata or files.
- Disconnect clears the browser session; Google authorization remains
  until revoked in Google Account connections.
- Network requests expire after ten seconds. Google's interactive window
  waits for the user's choice or cancellation, without a ten-second cutoff.
- A single account is active at a time. Background cleanup verifies its
  original account and pauses on authorization failure.

Review the updated privacy policy before publishing this auth flow.
No client secret belongs in a packaged extension.

## Tests

No dependencies or build step are required. From the repository root:

```sh
node --test auth-backend/tests/*.test.js extension/tests/*.test.js
node extension/tests/run.js
```

References:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developer.chrome.com/docs/extensions/reference/api/identity
- https://vercel.com/docs/functions/runtimes/node-js
