# Environment configuration

The Influencer Leads feature uses the OpenAI credential only inside the Cloudflare Worker. Never add a real key to `wrangler.jsonc`, browser code, or source control.

Owners and admins can enter the OpenAI key from **Find Creators → Settings**. The Worker encrypts that key with AES-GCM before storing it in D1 and never returns it to the browser. The wrapping key is a Worker secret named `AI_SETTINGS_ENCRYPTION_KEY`.

Set the wrapping secret once per Worker environment:

```sh
npx wrangler secret put AI_SETTINGS_ENCRYPTION_KEY
```

Alternatively, set `OPENAI_API_KEY` as a Worker secret to manage the key outside the CRM:

```sh
npx wrangler secret put OPENAI_API_KEY
```

For local development, both secrets can be placed in the ignored `.dev.vars` file. `OPENAI_MODEL` is a non-secret Worker variable in `wrangler.jsonc` and defaults to `gpt-5.6-terra`. `OPENAI_API_URL` may optionally be set server-side to change the compatible provider base URL; it defaults to `https://api.openai.com/v1`.

**Find Influencers** uses the Responses API web-search tool to locate public Instagram profiles. A user supplies a plain-language brief, a creator limit from 1–50, and an estimated spend limit from $0.05–$25. The Worker constrains search calls and output tokens and may reduce the effective creator limit to fit its conservative estimate. This is not an OpenAI account-level billing cap; the result reports actual API token usage, search calls, and an estimated cost.

Discovery pricing assumptions are configured as non-secret Worker variables: `OPENAI_DISCOVERY_INPUT_USD_PER_MTOK`, `OPENAI_DISCOVERY_OUTPUT_USD_PER_MTOK`, `OPENAI_WEB_SEARCH_USD_PER_CALL`, and `OPENAI_SEARCH_INPUT_TOKENS_ESTIMATE`. Update these when provider pricing changes.

Apply the D1 migration before using the page:

```sh
npx wrangler d1 migrations apply edgeform-crm --remote
```

For local development, omit `--remote`.

## Affiliate system

The affiliate portal (affiliate.edgeformmarketing.com) calls this Worker at `/api/affiliate/v1`. See `CONTRACT.md`. Worker secret:

| Secret | Used for |
|---|---|
| `AFFILIATE_ENCRYPTION_KEY` | AES-GCM wrapping key for creator payout details. Any long random string. Changing it makes stored payout details unreadable. |

```sh
npx wrangler secret put AFFILIATE_ENCRYPTION_KEY
```

There's no automated view tracking and no platform OAuth: staff check each video's views by hand, once a week, from the campaign's video list. See CONTRACT.md §3.

### Instagram connections (CONTRACT.md §8)

Affiliates can optionally link their Instagram Professional account so the weekly check has a
view count to confirm instead of a screenshot to read. This matters most for **trial reels**,
whose view count isn't public anywhere — but is readable with the account's own token.

| Setting | Where | Used for |
|---|---|---|
| `IG_APP_ID` | `wrangler.jsonc` var | Public Instagram app ID. Empty disables the feature and the portal hides the Connect button. |
| `IG_APP_SECRET` | Worker secret | Exchanging the OAuth code and refreshing long-lived tokens. |
| `AFFILIATE_ENCRYPTION_KEY` | Worker secret (existing) | Also encrypts stored Instagram tokens. |

```sh
npx wrangler secret put IG_APP_SECRET
npx wrangler d1 migrations apply edgeform-crm --remote
```

In the Meta App Dashboard, under the Instagram use case → **API setup with Instagram login**, add
this exact OAuth redirect URI:

```
https://edgeform-crm-api.edgeformmedia.workers.dev/api/affiliate/instagram/callback
```

Until the app passes **App Review** for Advanced Access, only Instagram accounts added as
**Instagram Testers** (App roles → Instagram Testers, and accepted from that account's
Instagram settings) can connect. Everyone else keeps uploading screenshots, which stays the
supported path — personal accounts can't connect at all.

Connections never price anything. The Worker writes to `video_api_views`, which pre-fills the
weekly entry box; a person still saves every priced week (CONTRACT.md §3).
