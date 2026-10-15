# Google OAuth verification

## Current blockers

Google's review requests a homepage and privacy policy on an owned,
verified domain, plus a more complete privacy policy. A successful OAuth
login or a public Web Store listing does not resolve these findings.

Google's specific domain-verification guidance requires a **Domain
property verified through DNS**, using an account associated with the
Google Cloud project. An HTML tag on a URL-prefix property alone is not
sufficient for this review. Shared `github.io` and `vercel.app` addresses
do not give this project control over the provider's DNS zone.

Do not claim these findings are resolved until the live pages and
ownership verification are actually complete.

## 1. Obtain a domain you control

Register a custom domain through an account you own. No purchase is
performed by this repository. Keep access to the domain's DNS settings.

## 2. Host the public pages on Vercel

Create a separate website project from this repository. Keep the existing
`auth-backend` project and its environment variables unchanged.

| Setting | Value |
| --- | --- |
| Framework | Other |
| Root Directory | Repository root (`.`) |
| Build Command | `node scripts/build-site.js` |
| Output Directory | `site` |

The build copies the canonical `index.html` and `privacy.html` into
`site/`. It does not copy extension code, auth server code, or credentials.
The generated directory is ignored by Git.

Add the custom domain in the website project's Domains settings and
apply the DNS records Vercel specifies. Keep both public pages accessible
without Vercel authentication. Both must use the same owned domain.

After the domain is live, update the privacy-policy link in
`extension/popup.html` to the new published policy URL before packaging
that extension update. The current link remains on the existing live
GitHub Pages policy until the replacement domain is known.

## 3. Verify ownership through DNS

1. Sign into Google Search Console with the Google account that owns
   the Google Cloud project `drivedeleter-510400`.
2. Add a property using the **Domain** card, rather than URL prefix.
3. Enter the owned root domain without `https://` or a path.
4. Copy Google's verification TXT record into that domain's DNS.
5. Click Verify and confirm the ownership status succeeds.
6. Keep the TXT record in place. Follow the review email's instruction
   to wait 24 hours after verification before retrying.

If Google cannot recognize the verifying account, check its project
role in Google Cloud IAM. Google's domain-verification page emphasizes
project-owner access; use the owner account to avoid ambiguity.

## 4. Update Google Auth Platform

Under Branding, set:

- App name: GoogleCleaner, matching the extension and public pages.
- Homepage: the live homepage on the new custom domain.
- Privacy policy: the live `privacy.html` page on the same domain.
- Authorized domains: the owned top private domain without protocol/path.
- Support/developer email: a monitored address that belongs to the developer.

Keep the existing Chrome extension redirect URI working; moving the
public homepage does not require changing the extension's identity or
its established auth backend origin. Do not delete a domain still used
by an OAuth client without reviewing that configuration.

Save the changes and follow the Verification Center's requested flow.
If branding edits are locked during review, use the controls described
in the Branding documentation to update the draft and resubmit.
Do not mark an app verified simply because its audience is In production.

## 5. Privacy and data-access review

The public policy describes account data, Drive metadata, authorization
codes and tokens, the Vercel service, device storage, retention,
protection, deletion, revocation, and Google Limited Use. The extension
also links to it directly. These disclosures must continue to match
actual code and hosting behavior.

The app requests `https://www.googleapis.com/auth/drive`, a restricted
scope. Brand approval alone does not complete restricted-scope review.
Provide Google's requested scope justification and demonstration video
of the actual sign-in, selection, review, confirmation, and cleanup flow.
Use disposable example files and avoid recording passwords or tokens.
The reason for this scope is access to existing owned files that were
not created or opened by the app; `drive.file` alone does not provide the
same inventory. Google determines any additional verification or
assessment requirements.

## 6. Reply to the review thread

Only after the pages are live, the domain is DNS verified, Cloud Console
URLs are saved, and the requested waiting period has passed, reply to
the existing Trust & Safety email thread. Include the final homepage
and privacy URLs, the verified domain, confirmation that the verifying
account is a project owner, and a short description of policy updates.
Never include client secrets or access tokens. This repository does
not send email or submit the review on the developer's behalf.

## Official references

- https://support.google.com/cloud/answer/13804266
- https://support.google.com/cloud/answer/13807376
- https://support.google.com/cloud/answer/13806988
- https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://vercel.com/docs/domains/working-with-domains/add-a-domain
