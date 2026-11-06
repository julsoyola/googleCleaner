# Recording script and caption text

Captions below describe the configured web-client recording. Actual
elapsed timings are written to each take's captions.srt and captions.json.
The native fallback uses its own introductory and consent captions.

| Approx. time | Show | Caption / operator action |
| --- | --- | --- |
| 0:00–0:06 | Real extension name | GoogleCleaner reviews owned Google Drive files and moves confirmed selections to Trash. Its OAuth app is named GooSweep. |
| 0:06–1:10 | Connect; actual Google popup | GoogleCleaner connects through the OAuth app GooSweep. Complete the real Google screens manually. Show English, warning, all permissions. Hold each for at least four seconds. |
| 1:10–1:18 | Actual connected account and files | OAuth grants account-wide Drive access. This labeled recording view shows only the two fixtures validated by ID, folder, and exact content. |
| 1:18–1:30 | Search/date/sort | Search, type, date, and sort filter the fetched inventory locally. Only disposable test files are shown. |
| 1:30–1:42 | PDF filter then Review | Review retains selections hidden by a filter. The selected TXT file remains in Review when the visible list is filtered to PDFs. |
| 1:42–2:00 | Review and confirmation | Confirmation names the account and selection. Only the single disposable review file will move to Trash. Operator approves this exact mutation. |
| 2:00–2:10 | Background job details | The background worker updates the selected file with trashed: true using Drive files.update. Nothing is permanently deleted. |
| 2:10–2:30 | Direct Drive file view | Verify the pinned file ID reports trashed: true and inspect its visual Trash status without opening the account-wide Trash listing. Do not empty Trash or permanently delete it. |
| 2:30–3:40 | Switch account; Google popup | Show this real consent entry point completely, in English. Return to the same expected Google account; do not claim a second account identity. |
| 3:40–3:50 | Account menu | Show the Disconnect option without activating it. The existing Chrome profile and sign-in are preserved. |

Timing depends on real Google screens. Never accelerate or omit consent
to fit this estimate. If Google does not show required evidence, note it
as missing; do not synthesize a Google screen or use the portfolio demo.

The caption strip is appended below the recording frame. It does not
cover consent permissions. Full Drive is the observed/current request,
not a claim that every narrower scope is unsuitable.

The folder is a recorder safety boundary, not an OAuth scope boundary.
No account-wide listing or Select all action is included. Exact fixture
IDs and hashes are stored privately in each take’s fixtures.json.
