# Real OAuth verification recording

Local recording tools for **GoogleCleaner**, whose configured Google OAuth
app is named **GooSweep**. This explanation is included in the captions.
The names are not changed. **Resolve the branding mismatch before submitting**:
Google requires the video to match the submitted app's name and branding.
A recording does not resolve domain ownership, privacy, scope justification,
or other verification findings, and approval is not guaranteed.

## Start

From the repository root, run:

```sh
bash oauth-verification/start.sh
```

To finish a failed take using its original uploaded fixture pair:

```sh
bash oauth-verification/start.sh --resume-run "$(pwd)/oauth-verification/.local/<run-timestamp>"
```

This performs read-only preflight **before starting capture**, then requests
fresh real consent for the recording. It does not regenerate or upload
fixtures. Setup choices are saved in a private `context.json`; resuming a
new run directory reuses those choices and the original fixture directory.

Requirements: macOS, installed Google Chrome, Node 22+, FFmpeg/FFprobe,
and Apple's Swift compiler.
No npm install, Playwright download, or project dependency is needed.
The runner uses Chrome's local debugging protocol to operate the actual
extension DOM. Google forms and passwords are never automated.

### Before capture — manual, not recorded

1. Enter the email for your **existing Google account** and the test
   folder's Drive URL or ID. Other files may remain in your account.
2. Acknowledge that OAuth still grants **account-wide Drive access**.
   Folder/fixture restrictions are recorder safeguards, not narrower
   Google permissions. The app still fetches owned-file metadata normally.
3. Reuse your existing recorder Chrome user-data folder at the prompt.
   The previous recorder profile is suggested automatically and retained
   between runs. Nothing resets, copies, signs out, or deletes your profile.
   Close that recorder Chrome instance normally before restarting it.
   Your ordinary Chrome profile is untouched; modern Chrome does not
   support remote debugging its normal default user-data directory.
4. Keep the already loaded extension, or load the printed unpacked folder
   if it is missing. Close other GoogleCleaner popup tabs. The runner opens
   the actual extension in a **labeled fixture-only recording view**.
5. For a new run, upload **both newly generated TXT files** from the printed
   fixtures directory into the selected Drive folder. With `--resume-run`
   or `--diagnose-run`, reuse that run's original uploaded pair instead.
   Preserve their names and contents exactly; unrelated runs cannot substitute.
   Other folder contents are allowed, but duplicate fixture names abort.
6. Sign into the expected account manually, before recording. Do not revoke
   existing app access or sign out your Chrome profile. If a connection is
   restored, the recorder uses the real account chooser for fresh consent.
7. Put the guarded extension tab and Google's OAuth window on the capture
   display. Close unrelated windows, hide notifications, and keep Terminal
   on another display when possible. Never open a second, unguarded
   extension popup, My Drive inventory, or account-wide Trash during capture.
8. Select **Capture screen** from the device list and allow your terminal
   in macOS Privacy & Security → Screen & System Audio Recording.

The runner asks **Start whole-screen video now** before capture. Google
warning and consent screens remain real, in English, and manually operated.
The worker's duplicate toolbar popup is suppressed only during this take
so it cannot expose an unfiltered inventory. The normal API is restored
on cleanup. No production source or OAuth configuration is changed.

For the configured web flow, preflight observes completion of the actual
Connect operation, including the callback, token exchange, and app loading.
The old connected view may stay visible during Switch account; it is never
treated as readiness. The recorder then checks a real Drive about request
using the app's token and confirms that the fixture reader uses that same
session. It validates the folder, both exact IDs, metadata, and file bytes.
Drive writes remain blocked throughout preflight, and capture starts only
after all these reads pass. Missing/duplicate fixture messages name the
role and local original path. No replacement pair is generated.

Authentication has a three-minute readiness deadline. A failure or timeout
preserves its sanitized operation, message, and stacks. One explicit RETRY
is offered without repeating setup. Finish or cancel a pending Google
window before retrying; the recorder never starts parallel sign-in flows.
Fixture reads likewise offer one bounded retry. After capture starts,
raw footage is kept even if a later action fails.

### Fixture safeguards

- Reads the selected real folder by ID, then paginates its direct children.
- Finds exactly one of each generated name, verifies real metadata and
  exact bytes, and pins both actual file IDs in the private `fixtures.json`.
- Requires regular owned TXT files, untrashed, with the selected folder as
  their sole parent. Shortcuts, folders, replacements, and other IDs fail.
- Shows no file rows until validation; afterward, only those pinned IDs
  can appear, including after Refresh, filtering, or account reauthorization.
- Reads both fixtures again before confirmation and before dispatch.
  Missing files, duplicate names, changed bytes, moved files, renamed files,
  wrong accounts, or changed IDs abort. No fallback file is ever selected.
- The only allowed target is the pinned **review** fixture. The keep file
  and folder never become Trash targets. No Select all control is used.
- A recording-only guard wraps the real background request and repeats
  account, ID, name, folder, and byte checks before every actual PATCH.
  Other Drive mutation methods and payloads are blocked during the take.
- No existing active/paused cleanup job is adopted or resumed. A debugger
  connection holds the guarded worker alive; if it disappears, the recorder
  stops rather than dispatching through an unguarded replacement worker.
  Normal abort cleanup blocks further writes and pauses only this take's
  still-active single-fixture job before restoring the original runtime APIs.
- Content reads are limited to the expected byte length. Tokens remain in
  the extension context; Node never receives or stores an access token.

These extra metadata/content reads and the fixture-only view are recording
safety aids, not claims about product features or folder-limited OAuth.
The actual app, real authorization, and real background Trash request are
used. Drive mutations remain real, so use only the generated disposable
files. The tools are not a transaction lock against outside Drive edits.

### During capture — manual Google consent

The script clicks the real **Connect Google Drive** control, then pauses.
You choose the expected account, set Google to **English**, show the actual
unverified-app warning, expand the complete requested permissions, and
approve consent yourself. Hold each screen at least four seconds.

Do not enter a password during recording. If Google requires one, stop
with Ctrl-C, complete sign-in off-recording, and start a fresh take.
Do not invent a warning if Google does not display it; that take lacks
that requested evidence. If your account cannot see the full consent,
stop and investigate the real configuration rather than fabricate it.

The recorder waits for the actual app result and successful same-session
Drive probe, then asks you to attest to the visible English consent footage.
It revalidates the original fixture IDs and bytes, then operates the real UI:

- Refresh the fixture-only recording view; demonstrate search, sorting, and date.
- Select the disposable review file, filter to PDFs, and show that Review
  retains the hidden TXT selection.
- Show the account and single-file Trash confirmation.
- Ask for a separate YES before moving **only the review fixture** to Trash.
- Enter that YES in **Terminal**. In this labeled recording view, the Chrome
  confirmation button stays disabled until the recorder revalidates the
  actual selected IDs, the account/count shown in confirmation, the Review
  contents, and both fixtures' metadata/bytes. The recorder then clicks it.
  PDF filtering may hide a selected TXT; approval uses `state.selectedIds`,
  independently of the visible inventory rows.
- Wait for the real background job result, then verify the exact Drive file ID reports `trashed: true` and the keep fixture's metadata and bytes remain unchanged.
- Open that exact file by its Drive ID for a visual Trash-status check.
  Never open the account-wide Trash listing, Delete forever, or Empty Trash.
  If Drive does not visibly show the status, abort rather than exposing an
  unrelated listing. The keep fixture stays in your selected test folder.
- Demonstrate **Switch account**, including the real Google screens again.
  Choose the same expected Google account. This covers that entry point;
  it does not claim a switch between two different account identities.
- Show the account menu, then finish without disconnecting your account.
  No consent steps are removed or sped up.

The output has readable captions burned into a strip **below** the screen.
No Google content is covered. Audio is disabled. Aim for 2–4 minutes;
manual consent and complete evidence take priority over duration.

### Outputs and review

Primary MP4:

```text
~/Downloads/GooSweep-OAuth-Demo-<timestamp>.mp4
```

Each take also produces an ignored private directory:

```text
oauth-verification/.local/<timestamp>/
  fixtures/             Two uniquely generated disposable upload files
  fixtures.json         Pinned Drive IDs, folder ID, names, content hashes
  temp/raw.mp4          Failed/debug take: uncut screen recording
  captions.json         Actual elapsed caption timings
  captions.srt          Copyable subtitle text and timings
  temp/caption-*.png    Temporary rendered caption strips
  temp/capture.log      Failed/debug take: FFmpeg diagnostics
  review.json           Failed/debug take: evidence and unresolved checks
  context.json          Failed/debug take: private resume settings
  diagnostic*.json      Failed take: sanitized errors and stacks
  summary.json          Compact sanitized result
  run-manifest.json     Generated artifact ownership and retention
```

`oauth-verification/.local/latest-run.txt` points to the latest successful
run. Each new final has a unique filename; prior exports stay untouched.
A failed/aborted run stays private and never claims a validated export.
Failures also write `diagnostic.json` with the failing operation, sanitized
exception message, browser stack, and Node stack. Evaluation expressions,
remote objects, credential text, and private URL parameters are not logged.
The same diagnostic is included as `failure` in `review.json`.
The first guard rejection is retained with its condition and safe
expected/actual values; a later approval attempt cannot clear that latch.
Unexpected selection IDs/names are redacted. `approval.json` records the
validated selection and confirmation state before dispatch, and failed
runs retain a safe `guardSnapshot` in `review.json` when the tab is available.

To repeat only the post-consent reads for an existing failed run, use
`start.sh --diagnose-run <absolute-failed-run-directory>`. This reuses the
original fixture names and bytes and the selected recorder Chrome profile.
Enter the same account and folder, complete consent manually, and leave the
original uploaded files unchanged. No video is captured. Drive mutations
are blocked in the guarded app and worker; the script exits immediately
after fixture identification, before selection, approval, or job dispatch.
Its diagnostic is saved in a new private run directory. The original
review and fixtures stay untouched. A fresh consent is needed because
closing Chrome ends the extension's in-memory authorization session.

The reused Chrome profile lives at the selected existing path, recorded
in `.local/profile-path.txt` (native mode uses its own pointer).
It can contain credentials/cookies managed by Chrome;
the recorder never reads them. Do not share the private run directory.
Files are created with private permissions and ignored by Git.

**Play the entire final MP4 yourself.** Confirm all of the following:

- [ ] Correct local app, OAuth client, and submitted branding.
- [ ] Complete English consent, every permission, readable text.
- [ ] Real unverified warning where Google displays it.
- [ ] Connect and Switch account consent entry points.
- [ ] Account identity, inventory read, review, and real Trash update.
- [ ] Exact pinned file ID has confirmed Trash status in Drive.
- [ ] No passwords, authorization codes, tokens, unrelated personal info.
- [ ] Every distinct OAuth implementation included in the submission.

`review.json` records manual attestations, not a visual machine audit.
The tool verifies an MP4 video stream and duration; it cannot prove a
reviewer could read every screen. Inspect playback before sharing.
Nothing is uploaded, published, submitted, or deployed by these tools.

## OAuth implementations and API evidence

Audited sources, not the simulated portfolio demo:

| Integration | Source | Recording evidence |
| --- | --- | --- |
| Configured web client + PKCE | `extension/auth.js:49–70`, `extension/auth-config.js` | Real Connect / Switch account consent |
| Server code exchange and refresh | `auth-backend/lib/oauth.js:62–94` | Real successful sign-in; silent refresh is not a separate consent UI |
| Native Chrome identity fallback | `extension/manifest.json`, `extension/popup.js:121–172` | Inactive with current auth origin; supplemental workflow below |
| Account identity | `extension/popup.js:238–241`, `extension/background.js:59–65` | Connected account label; Drive about |
| Owned non-trashed metadata, pagination | `extension/popup.js:243–261` | Real files appear after consent / Refresh; Drive files.list |
| Local search, type/date/sort | `extension/popup.js:265–313` | Search/date/sort and hidden selection in Review |
| Background Trash operation | `extension/background.js:70–96` | Confirmed single file, real job result, Drive Trash |
| Resume after auth expiry | `extension/popup.js` `reconnectJob` | Requires reconnect through existing Connect first; no separate consent flow |
| Open in Drive | `extension/popup.js` `buildFileRow` | Normal webViewLink; no extra API/scope |

Verified public configuration at implementation time:

```text
Extension ID: acijddppbcekpnlddndfomahlpgcnfoe
Active web client:
1058637387456-e8j4miietnq70him9cksb8bl3tqq1qsg.apps.googleusercontent.com
Native fallback client:
1058637387456-nr0gdht0tfji3bqt5f1t3p02jdj0id8v.apps.googleusercontent.com
Scope (both implementations):
https://www.googleapis.com/auth/drive
Redirect:
https://acijddppbcekpnlddndfomahlpgcnfoe.chromiumapp.org/
```

The preflight fetches `/api/config` again and checks the current public
client, scope, and redirect against the extension manifest. It never
reads backend environment variables or a client secret. Validation uses
the existing in-extension token internally, without exporting it to Node.
When visible through Chrome targets, the runner retains only public
client ID, scope, and redirect parameters from authorization requests.
It does not retain complete URLs, state values, or authorization codes.
If Chrome does not expose that target, compare the consent permissions
manually; no live request observation is claimed.

No `openid`, `email`, `profile`, Gmail, or other Google API integration
was found in the actual auth/Drive source. Account email comes from
Drive about. Chrome permissions `identity`, `storage`, and `alarms` and
host permissions are not additional OAuth consent scopes.

The current local extension uses the existing configured HTTPS auth
service. The tools do not alter that service or production configuration.
Only the account's real authorization and validated review fixture are
changed. There is no local replacement backend or simulated Google API.

### Supplemental native fallback

Google asks for every distinct consent workflow included in review.
The configured build has a second implementation in code, selected only
when `authOrigin` is empty. The primary take **does not** cover that client.
If the native implementation is part of your submission, also run:

```sh
bash oauth-verification/start.sh --native
```

This makes an **ignored staging copy** of the extension with an empty
auth origin, retaining its identity and requested scopes. Original sources
remain untouched. Follow the printed load-unpacked path and sign into the
Chrome profile with the test account before capture. Switch account is not supported by the native branch; that supplemental
take demonstrates its real Connect flow only. The supplemental video is `~/Downloads/GooSweep-OAuth-Native-Fallback-<timestamp>.mp4`. Check its actual
consent branding; do not assume it is GooSweep. If Chrome identity fails
or the existing sign-in timeout prevents complete consent, mark this
workflow blocked. Do not alter timeouts/scopes or fake a successful flow.
Keep both complete recordings together for later manual review. These
tools do not decide which OAuth clients Google is verifying.

## Scope justification: unresolved, not invented

Full Drive scope is the current request and is preserved. The recording
shows its actual use: existing owned-file metadata and explicit Trash
updates. It does **not** assert that narrower scopes are impossible.
Google's files.update documentation also lists `drive.metadata` and
`drive.file`, among others. A separate minimum-scope review must evaluate
these against every current endpoint and desired inventory behavior.
Do not submit a claim that only full Drive can move a file to Trash.

The portfolio interactive demo was inspected: it loads `mock-adapter.js`
and declares `connect-src 'none'`; all results are simulated. It is
intentionally excluded from this recording workflow.

## Checks and fallback

Checks that do not record the screen or sign into Google:

```sh
bash oauth-verification/start.sh --check
node --test oauth-verification/support.test.mjs
node --test oauth-verification/auth-readiness.test.mjs
```

If Chrome is already running with the selected recorder profile, close
that instance normally and restart. Do not reset or delete the profile.
If Google refuses sign-in or screen permissions block capture, stop and
fix the actual issue. Do not bypass Google security or record an unguarded
manual inventory as a workaround. A failed guard leaves the take incomplete.

Additional real-browser DOM check, using local in-memory test doubles
only, with HTTPS blocked and no Google sign-in or Drive mutation:

```sh
node --test oauth-verification/browser-smoke.test.mjs
```

## Google checklist sources

https://support.google.com/cloud/answer/13804565?hl=en
https://developers.google.com/workspace/drive/api/guides/api-specific-auth
https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update
https://developer.chrome.com/docs/extensions/reference/api/identity


## Local output retention

A normal start makes a fresh recording and saves a uniquely timestamped MP4
in Downloads. Existing videos are preserved; no rename or finalization step
is needed. Google consent and file-action checkpoints remain manual.

Each run owns a private `.local/<timestamp>/temp/` directory. Its manifest
lists generated artifacts and their purposes. The final `export.mp4`,
Downloads copy, captions, reusable source assets and small sanitized
`summary.json` remain. Browser profiles and required authentication state
are never cleanup targets. Private run data and media stay ignored by Git.

After export, both final MP4s must be nonempty, have a video stream, fully
decode, and match expected dimensions and duration. Only then does automatic
cleanup move that run's raw footage, generated screenshots, caption frames,
encoded segments, temporary audio, renderer binary and verbose logs/reports
to macOS Trash. Unneeded successful-run context and validation reports are
also discarded. Anything required by another active or resumable run stays.
Trash is never emptied. `--finalize-run` is no longer required.

On failure, regenerable cards, captions and encoded segments are discarded.
Raw footage, checkpoint screenshots, original sanitized errors, capture logs,
and fixture/resume metadata remain for diagnosis or an explicit resume.
The terminal prints an exact `--cleanup-run` command. Run it only when that
evidence is no longer needed: it trashes explicitly owned failed-run media,
reports and private context, while preserving fixtures, profiles, captions,
summary, source files, final videos and other runs' dependencies.
`--cleanup-run <run> --dry-run` previews that targeted discard.

From the project root:

```sh
bash oauth-verification/start.sh
bash oauth-verification/start.sh --cleanup --dry-run
bash oauth-verification/start.sh --cleanup
bash oauth-verification/start.sh --keep-intermediates
bash oauth-verification/start.sh --cleanup-run /absolute/path/to/.local/TIMESTAMP --dry-run
```

`--keep-intermediates` disables automatic cleanup and ordinary cleanup for
that debug run. Explicit `--cleanup-run` can discard its failed evidence.
Legacy raw footage from before this policy remains protected; the optional
legacy `--finalize-run <run>` command still validates its final before Trash.
Ordinary cleanup preserves the latest failed run and uncertain older runs.

Cleanup rejects unknown files, symlinks, hard links, source files, final
videos, active outputs and saved dependencies. References and active file
usage are checked again before each move. Missing or ambiguous configuration
causes cleanup to skip and report its reason. No authentication, Drive
mutation, profile reset or OAuth change occurs during cleanup.

A normal start never implicitly resumes a saved failed take. Use
`--resume-run <absolute-run-path>` explicitly to reuse its original pinned
fixture pair; genuine fixture mismatches still stop the run. Existing
pending-run references remain protected but do not change the normal start.
The retention policy and tests are vendored from `project-demo-video/lib/`
and `project-demo-video/tests/`; keep the matching copies identical.
