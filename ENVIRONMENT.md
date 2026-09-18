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

The affiliate portal (affiliate.edgeformmarketing.com) calls this Worker at `/api/affiliate/v1`. See `CONTRACT.md`. Worker secrets:

| Secret | Used for |
|---|---|
| `AFFILIATE_ENCRYPTION_KEY` | AES-GCM wrapping key for creator payout details and platform OAuth tokens. Any long random string. Changing it makes stored payout details unreadable. |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key for polling view counts. |
| `APIFY_TOKEN` | Apify API token, the TikTok / Instagram view-count scraper. |

```sh
npx wrangler secret put AFFILIATE_ENCRYPTION_KEY
npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put APIFY_TOKEN
```

`VIEW_PROVIDER_TIKTOK` and `VIEW_PROVIDER_INSTAGRAM` in `wrangler.jsonc` choose `oauth` (the creator's connected account) or `scraper` (Apify) per platform.

### TikTok and Instagram account connections

Affiliates can connect their TikTok and Instagram accounts from the portal's settings page, so view counts come from the platforms' own APIs. Until an app's secrets are set, `POST /connections/:platform/start` returns `501 not_available`.

| Secret | Where it comes from |
|---|---|
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok for Developers app with Login Kit (web). Scopes: `user.info.basic`, `user.info.profile`, `video.list`. Redirect URI: `https://edgeform-crm-api.edgeformmedia.workers.dev/api/affiliate/v1/oauth/tiktok/callback` |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Meta app with the "Instagram API with Instagram Login" product. Scopes: `instagram_business_basic`, `instagram_business_manage_insights`. Redirect URI: `https://edgeform-crm-api.edgeformmedia.workers.dev/api/affiliate/v1/oauth/instagram/callback`. Only Business or Creator Instagram accounts can connect. |

Once an app is live, set its `VIEW_PROVIDER_*` var to `oauth`. Videos from creators who haven't connected, or that aren't in the connected account, fall back to Apify when `APIFY_TOKEN` is set. With neither available, a video waits and locks on manually entered views.
