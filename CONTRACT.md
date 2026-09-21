# Edgeform Affiliate System — Shared Contract (v8)

Source of truth for BOTH builds. An identical copy lives in both repos:
- **CRM agent** → `edgeform-crm` (Cloudflare Worker `edgeform-crm-api` + D1 `edgeform-crm` + static admin UI at crm.edgeformmarketing.com). Owns the database, admin UI, view polling, earnings, payouts, and the affiliate API.
- **Portal agent** → `affiliate.edgeformmarketing.com` (static HTML/CSS/vanilla JS, same style as the CRM). Affiliate-facing UI only. Talks to the CRM Worker through the API in §4 and never touches D1.

**Rule:** nobody renames or removes a table, column, enum value, endpoint, or JSON key in this file without updating this file in BOTH repos first and telling the user. Adding things is fine.

---

## 0. Conventions (matched to the existing CRM)
| Thing | Rule |
|---|---|
| IDs | opaque `TEXT`. New rows: `crypto.randomUUID()`. Existing tables keep what they have. Never parse IDs. |
| DB columns | `snake_case` |
| JSON keys (affiliate API) | `snake_case` (the affiliate API is separate from the admin API, which keeps its own camelCase) |
| Timestamps | ISO 8601 UTC `TEXT` via `now()` in `worker/lib.js`, e.g. `2026-09-18T14:00:00.000Z` |
| Dates | `TEXT` `YYYY-MM-DD` |
| Booleans | D1: `INTEGER` 0/1. JSON: `true`/`false` |
| Arrays | D1: JSON `TEXT` (like `creators.niches`). JSON: real arrays |
| Money | integer **cents** everywhere (`cpm_rate_cents: 2500` = $25.00 per 1,000 views). Never `REAL`. |
| Currency | `"USD"` |
| Nullable | send `null`, never omit the key |
| Success | `{ "ok": true, ...payload }` |
| Error | HTTP status + `{ "ok": false, "error": "Human message.", "code": "machine_code" }` |
| Lists | `{ "ok": true, "data": [ ... ] }` (no pagination in v1) |

---

## 1. Enums (exact strings; enforce with `CHECK` in D1)
```
campaign_status:    draft | active | paused | ended
channel_type:       email | affiliate
platform:           tiktok | instagram | youtube
assignment_status:  invited | active | removed
video_status:       pending_review | approved | rejected | removed | locked
view_source:        manual (api / oauth / scraper are retired, v4 — see §3. Historical rows keep them.)
payout_status:      pending | approved | paid | failed
payout_method:      paypal | wise | bank | manual
flag_type:          handle_mismatch | video_unavailable | suspicious_spike (fetch_failed retired, v4 — automated-fetch only. Historical rows keep it.)
```

---

## 2. D1 tables (CRM agent writes the migrations: `0019_affiliate_campaigns.sql`, …)

### operations (existing, no changes)
Campaigns hang off operations. The Campaigns section only appears on operations where `type = 'marketing'`.

### creators (existing, only ADD columns)
Keep and reuse: `id, name, email, phone, phone_e164, instagram, tiktok, youtube, location, roster_status, created_at, updated_at`.
`instagram` / `tiktok` / `youtube` stay free text (handle or URL). Normalize when comparing (strip `@`, URL prefix, lowercase).

ADD:
| column | type | notes |
|---|---|---|
| payout_method | TEXT NULL | payout_method enum |
| payout_details_encrypted | TEXT NULL | AES-GCM with a new secret `AFFILIATE_ENCRYPTION_KEY` (same pattern as the OpenAI key in ENVIRONMENT.md). Never returned. |
| payout_details_last4 | TEXT NULL | safe to show. Bank: last 4 digits (`4821`). PayPal/Wise email: masked email (`j•••@gmail.com`). Manual: NULL |
| tax_form_received | INTEGER NOT NULL DEFAULT 0 | |
| country | TEXT NULL | ISO-2 |
| portal_last_login_at | TEXT NULL | |

Portal login key = `creators.email`, matched case-insensitively. `email` isn't unique today, so the CRM agent checks for duplicates before adding
`CREATE UNIQUE INDEX idx_creators_email ON creators(email COLLATE NOCASE) WHERE email <> ''`.

"Assigned to: Campaign A, Campaign B" on the Creators list is derived from `campaign_affiliates`. Don't store it as a field.

### campaigns
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| operation_id | TEXT NOT NULL → operations.id ON DELETE CASCADE | |
| name | TEXT NOT NULL | |
| brief | TEXT NOT NULL DEFAULT '' | shown to affiliates |
| status | TEXT NOT NULL DEFAULT 'draft' | campaign_status |
| start_date | TEXT NULL | |
| end_date | TEXT NULL | |
| platforms_allowed | TEXT NOT NULL DEFAULT '["tiktok","instagram","youtube"]' | JSON array of platform |
| default_cpm_rate_cents | INTEGER NOT NULL DEFAULT 0 | |
| currency | TEXT NOT NULL DEFAULT 'USD' | |
| max_payout_per_video_cents | INTEGER NULL | |
| max_payout_per_affiliate_cents | INTEGER NULL | |
| total_budget_cents | INTEGER NULL | |
| min_views_to_qualify | INTEGER NULL | cumulative lifetime views a video must reach before ANY week counts (see §3) |
| requires_video_approval | INTEGER NOT NULL DEFAULT 1 | |
| created_by | TEXT NULL → users.id | |
| created_at / updated_at | TEXT NOT NULL | |

### campaign_channels
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| campaign_id | TEXT NOT NULL → campaigns.id CASCADE | |
| type | TEXT NOT NULL | channel_type. UNIQUE(campaign_id, type) |
| created_at | TEXT NOT NULL | |
New campaigns get both channels. `email` is a placeholder tab with no logic yet.

### campaign_affiliates
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| campaign_id | TEXT NOT NULL → campaigns.id CASCADE | |
| creator_id | TEXT NOT NULL → creators.id CASCADE | UNIQUE(campaign_id, creator_id) |
| cpm_rate_override_cents | INTEGER NULL | NULL = use the campaign default |
| status | TEXT NOT NULL DEFAULT 'invited' | assignment_status |
| invited_at | TEXT NULL | set when the invite email goes out |
| joined_at | TEXT NULL | set on the creator's first portal login after being invited |
| created_at / updated_at | TEXT NOT NULL | |

`effective_cpm_rate_cents = COALESCE(cpm_rate_override_cents, campaigns.default_cpm_rate_cents)`

### videos
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| campaign_affiliate_id | TEXT NOT NULL → campaign_affiliates.id CASCADE | |
| campaign_id | TEXT NOT NULL | copied here to make queries simpler |
| creator_id | TEXT NOT NULL | copied here to make queries simpler |
| submitted_url | TEXT NOT NULL | exactly what the affiliate pasted |
| platform | TEXT NOT NULL | detected server-side |
| platform_video_id | TEXT NOT NULL | UNIQUE(platform, platform_video_id) across ALL campaigns |
| canonical_url | TEXT NOT NULL | |
| thumbnail_url | TEXT NULL | |
| caption | TEXT NULL | |
| posted_at | TEXT NULL | |
| status | TEXT NOT NULL | video_status. Starts as `pending_review` if the campaign requires approval, otherwise `approved` |
| rejection_reason | TEXT NULL | |
| submitted_at | TEXT NOT NULL | |
| approved_at | TEXT NULL | |
| approved_by | TEXT NULL → users.id | |
| locked_at | TEXT NULL | set when the campaign ends (see §3) |
| latest_view_count | INTEGER NOT NULL DEFAULT 0 | cumulative total as of the last weekly check; also next week's baseline |
| billable_views | INTEGER NOT NULL DEFAULT 0 | frozen copy of latest_view_count when the video locks |
| earned_cents | INTEGER NOT NULL DEFAULT 0 | running total of its own priced weeks (see §3); cached, never decreases |
| last_fetched_at | TEXT NULL | last weekly check |

No more per-video tracking window and no automated retries: `tracking_ends_at`, `next_fetch_at`, `consecutive_fetch_failures` are retired (v4). The CRM's own DB still carries these columns, unused, rather than risk a schema rebuild on a live table — nothing reads or writes them.

### view_snapshots (append-only, never update or delete)
`id TEXT PK, video_id TEXT NOT NULL → videos.id CASCADE, view_count INTEGER NOT NULL, like_count INTEGER NULL, comment_count INTEGER NULL, source TEXT NOT NULL (view_source), fetched_at TEXT NOT NULL, raw_response TEXT NULL (JSON, always NULL going forward), entered_by TEXT NULL → users.id, note TEXT NULL, delta_views INTEGER NULL, earned_cents INTEGER NULL`

`delta_views` = `view_count` − the video's `latest_view_count` before this check, floored at 0, set the moment the row is inserted. `earned_cents` is set once, by the same pricing pass that updates `videos.earned_cents` (§3), and is never changed again — a row with `earned_cents IS NULL` is an unpriced week still waiting to be priced. Rows from before v4 have both columns `NULL` and are simply invisible to pricing; the videos they belong to keep whatever `earned_cents` they already had.

### video_flags
`id TEXT PK, video_id TEXT NOT NULL → videos.id CASCADE, type TEXT NOT NULL (flag_type), details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, resolved_at TEXT NULL, resolved_by TEXT NULL → users.id`

### payouts
`id TEXT PK, creator_id TEXT NOT NULL → creators.id, period_start TEXT, period_end TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'pending' (payout_status), payment_method TEXT NULL (payout_method), payment_reference TEXT NULL, paid_at TEXT NULL, created_by TEXT NULL → users.id, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`

### payout_line_items
`id TEXT PK, payout_id TEXT NOT NULL → payouts.id CASCADE, view_snapshot_id TEXT NULL → view_snapshots.id, video_id TEXT NOT NULL → videos.id, campaign_id TEXT NOT NULL, billable_views INTEGER NOT NULL, cpm_rate_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL`
A priced week is paid at most once: UNIQUE(view_snapshot_id). A video can be on many payouts over its life — one per paid week (v4; was one payout ever, per video, in v3). `view_snapshot_id` is NULL on rows from before v4, which predate the concept.

### affiliate_login_tokens
`token_hash TEXT PK (sha256), creator_id TEXT NOT NULL → creators.id CASCADE, expires_at TEXT NOT NULL (15 min), used_at TEXT NULL, created_at TEXT NOT NULL`

### affiliate_sessions (kept separate from the CRM staff `sessions` table)
`token_hash TEXT PK (sha256), creator_id TEXT NOT NULL → creators.id CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL (30 days)`

### affiliate_audit_log
`id TEXT PK, actor_type TEXT NOT NULL ('user' | 'creator' | 'system'), actor_id TEXT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NULL, after_json TEXT NULL, created_at TEXT NOT NULL`
Log: rate changes, manual view entries, approvals and rejections, payout status changes, and changes to payout details.

---

## 3. Weekly manual entry and formulas (v4 — only the CRM computes these; the portal just displays them)

Views are no longer polled automatically. Staff check each actively-tracking video's view count by hand,
once a week, and enter the new cumulative total. There's a single global weekly cutoff — the most recent
past **Sunday 10pm America/New_York** — used only to build the admin's "this week's checklist" of videos
not yet checked since then; nothing about pricing itself depends on hitting that exact time.

### Pricing a weekly entry (`POST /api/affiliate-videos/:id/views`, CRM admin only)
```
delta_views  = max(0, entered_view_count − video.latest_view_count)   // floored at 0, never negative
→ append a view_snapshots row (view_count = entered_view_count, delta_views), video.latest_view_count = entered_view_count
→ price it (below), store the result on that row's earned_cents, add it to video.earned_cents
```
A video only takes new entries while its campaign is `active` or `paused` and the video itself is
`approved`. Once a video is `locked` (its campaign ended), entries are rejected — locking is a hard stop,
not a data-correction point.

### Pricing (per week, walking every campaign's still-unpriced weeks oldest-first)
```
qualifies   = min_views_to_qualify is unset OR this week's cumulative view_count >= min_views_to_qualify
              (cumulative, not per-week: weeks before a video crosses the bar earn 0; the crossing week
              and every week after earn normally on their own delta)
raw_cents   = qualifies ? floor(delta_views * effective_cpm_rate_cents / 1000) : 0
week_cents  = raw_cents, capped so the VIDEO's running total (across all its priced weeks) never exceeds
              max_payout_per_video_cents, then so the AFFILIATE's running total of their OWN videos never
              exceeds max_payout_per_affiliate_cents (uplines' override earnings don't count against this
              cap — only their own posted videos), then so the CAMPAIGN's running total (own earnings +
              overrides) never exceeds total_budget_cents
→ add week_cents to videos.earned_cents; store it on the view_snapshots row (earned_cents)
```
**Once a week is priced, it's permanent** — a later CPM rate change, cap change, or budget change only
ever affects weeks priced after it. Nothing ever re-prices an already-priced week. This is what makes
weekly payment ("creators get paid weekly") safe: money already told to a creator never moves.
Uplines: identical rule as v3 (below), applied per week instead of per video's lifetime.

### Campaign ending (locks tracking, permanent)
Setting a campaign's `status` to `ended` immediately locks every one of its still-`approved` videos:
`status = locked`, `billable_views = latest_view_count`, `locked_at = now`. No more weekly entries are
possible for them. Setting a campaign to `paused` does **nothing** to its videos — it's a temporary hold:
paused videos simply drop off the weekly checklist (staff naturally skip them) and pick back up exactly
where they left off once the campaign is `active` again. There's no reverse cascade if an `ended` campaign
is somehow reactivated — locked videos stay locked.

### Removed and rejected videos
A video moved to `removed` (by staff, including the "mark unavailable" action for a deleted/private post)
keeps whatever `earned_cents` it already has — frozen, exactly like a priced week — and takes no further
entries. A `rejected` video never earned anything and can't be rejected once any week of it has been paid
(remove it instead).

### Totals
```
earned_cents   (per creator) = Σ videos.earned_cents + Σ override_earnings.amount_cents
                                (everything approved is immediately earned — paid weekly, no "pending" bucket)
paid_cents                   = Σ payouts.amount_cents where status = paid
owed_cents                   = earned_cents − paid_cents
```
A payout can be created from any priced, unpaid week on an `approved` or `locked` video — not only once a
video locks. This is what lets a creator be paid every week their videos are checked.

---

## 4. Affiliate API (the CRM Worker serves it; the portal calls it)
Base: `${API_URL}/api/affiliate/v1`, which is currently `https://edgeform-crm-api.edgeformmedia.workers.dev/api/affiliate/v1`
Auth: `Authorization: Bearer <session_token>` on everything except `/auth/*`. The creator is always taken from the session. The portal never sends a `creator_id`.
CORS: add `https://affiliate.edgeformmarketing.com` and `http://localhost:5500` to `ALLOWED_ORIGINS`.
Error codes shared by every endpoint: `unauthorized` (401), `not_found` (404), `validation_error` (400), `rate_limited` (429).

### Auth
| method | path | body | returns |
|---|---|---|---|
| POST | /auth/magic-link | `{ "email" }` | `{ "ok": true }`, whether or not the email exists. Only emails creators that have at least one `campaign_affiliates` row with status ≠ removed. Max 5 per email per hour. |
| POST | /auth/verify | `{ "token" }` | `{ "ok": true, "session_token", "expires_at", "creator": Creator }`. Error code `invalid_token`. Sets `joined_at` and `status = active` on that creator's `invited` assignments. |
| POST | /auth/logout | — | `{ "ok": true }` |

The magic-link email is sent through the existing mail code, from `MAIL_FROM`, and links to `https://affiliate.edgeformmarketing.com/verify.html?token=<raw token>`.
The invite email (sent when an admin adds an affiliate to a campaign) links to `https://affiliate.edgeformmarketing.com/`.

### Me
| GET | /me | → `{ ok, creator: Creator }` |
| PATCH | /me | any of `{ name, phone, instagram, tiktok, youtube, country, payout_method, payout_details }` → `{ ok, creator: Creator }`. `payout_details` is write-only. The server encrypts it and sets `payout_details_last4`. |

### Campaigns
| GET | /campaigns | → `{ ok, data: CampaignSummary[] }`: campaigns this creator is assigned to, where the assignment isn't `removed` and the campaign isn't `draft` |
| GET | /campaigns/:id | → `{ ok, campaign: CampaignDetail }` |

### Videos
| GET | /campaigns/:id/videos | → `{ ok, data: Video[] }`, newest first |
| POST | /campaigns/:id/videos | `{ "url" }` → `201 { ok, video: Video }` |
| DELETE | /videos/:id | only while `pending_review` → `{ ok: true }`. Otherwise `409` with code `not_deletable` |

POST error codes: `invalid_url`, `unsupported_platform`, `platform_not_allowed`, `duplicate_video`, `campaign_not_active`, `not_assigned`.
The server follows short links (vm.tiktok.com, youtu.be, instagram share links) before it reads the ID.

Platform connections (OAuth for TikTok/Instagram) are retired (v4) — there was never a live provider
behind them. `/connections`, `/oauth/:platform/*`, and the `creator_platform_connections` table are gone;
nobody should still be calling them.

### Earnings and payouts
| GET | /earnings | → `{ ok, earnings: Earnings }` |
| GET | /payouts | → `{ ok, data: Payout[] }`, newest first |

### Response shapes (every key is always present; missing values are `null`)
```jsonc
// Creator
{ "id", "name", "email", "phone", "instagram", "tiktok", "youtube", "country",
  "payout_method", "payout_details_last4", "tax_form_received" }

// CampaignSummary
{ "id", "name", "status", "start_date", "end_date", "platforms_allowed",
  "cpm_rate_cents",            // effective rate for THIS creator
  "currency", "assignment_status",
  "video_count", "total_views", "earned_cents" }   // no more pending_cents (v4): everything approved is already earned

// CampaignDetail = CampaignSummary plus
{ "brief", "min_views_to_qualify",
  "max_payout_per_video_cents", "requires_video_approval" }

// Video
{ "id", "campaign_id", "submitted_url", "canonical_url", "platform", "thumbnail_url", "caption",
  "posted_at", "status", "rejection_reason", "submitted_at", "locked_at",
  "latest_view_count", "billable_views", "earned_cents", "last_fetched_at" }

// Earnings
{ "currency", "earned_cents", "paid_cents", "owed_cents",
  "by_campaign": [ { "campaign_id", "campaign_name", "earned_cents", "paid_cents", "owed_cents" } ] }

// Payout
{ "id", "period_start", "period_end", "amount_cents", "currency", "status", "payment_method",
  "payment_reference", "paid_at",
  "line_items": [ { "video_id", "campaign_id", "campaign_name", "canonical_url", "billable_views", "cpm_rate_cents", "amount_cents", "week_of" } ] }
```
`week_of` (added v4) is when that week's check happened — each line item is one priced week, not a whole video.
Never sent to the portal: creator notes, `roster_status`, `payout_details_encrypted`, `raw_response`, flags, audit log, other creators' data.

---

## 5. Who builds what
| CRM agent (`edgeform-crm`) | Portal agent (`affiliate.edgeformmarketing.com`) |
|---|---|
| Migrations for §2 | Static site: `index.html` (login), `verify.html`, `dashboard.html`, `campaign.html?id=`, `payouts.html`, `settings.html` |
| Campaigns section on marketing operations (Email tab placeholder, Affiliate tab) | Magic-link login and session in localStorage |
| Add affiliate: choose from Creators, or create one inline (which adds them to Creators) + invite email | Campaign list and detail pages |
| "Assigned to" column and campaign filter on the Creators list | Add Video flow, with a clear message for every error code |
| `worker/affiliate.js` serving all of §4 | Video table: status, views, earnings |
| URL parsing, short-link resolving, duplicate check | Earnings dashboard and payout history |
| Weekly view entry, pricing, campaign-end locking, flags (all CRM-only, v4 — no portal work here) | Settings: profile, payout method (no account connections, v4) |
| Admin: video review queue, weekly checklist, flags, payouts, CSV export, audit log | `mock-api.js` that follows §4 exactly, turned on with `?mock=1`, so the portal can be built before the CRM API is live |

**Sync point:** once the CRM's `/api/affiliate/v1` is deployed, the portal's `API_BASE` in `config.js` points at it and nothing else changes.

---

## 6. Uplines and ranks (added in v3, additive only)

Each campaign can be an MLM-style tree. Nothing above was renamed or removed. These are new keys, a new endpoint, and one formula change: `owed_cents` now includes overrides.

### New enum
```
rank: top_creator | master | general | rookie
```

### D1 (migration `0020_affiliate_uplines.sql`, `0021_affiliate_manual_views.sql`)
- `campaign_affiliates.upline_id` TEXT NULL → campaign_affiliates.id (same campaign). NULL = top of a tree.
- `campaign_affiliates.rank` TEXT NOT NULL DEFAULT 'rookie' (rank enum). Rank is a label; money comes from each person's CPM.
- `override_earnings`: `id, view_snapshot_id, video_id, campaign_id, campaign_affiliate_id` (the upline who earns), `creator_id, source_campaign_affiliate_id` (who posted), `depth, cpm_diff_cents, amount_cents`. UNIQUE(view_snapshot_id, campaign_affiliate_id) (v4; was UNIQUE(video_id, campaign_affiliate_id) — an upline now earns an override per priced WEEK of a downline's video, not once per video). `view_snapshot_id` is NULL on rows from before v4.
- `payout_override_items`: `id, payout_id, view_snapshot_id, video_id, campaign_affiliate_id, campaign_id, source_campaign_affiliate_id, billable_views, cpm_diff_cents, amount_cents`. UNIQUE(view_snapshot_id, campaign_affiliate_id) (v4, same reason).

### Override formula (v5: a percentage of the downline's pay, priced per week alongside §3)
v5 (migration `0022_affiliate_override_percent.sql`) replaced the v4 CPM-difference rule. New D1 columns:
- `campaigns.default_override_bps` INTEGER NOT NULL DEFAULT 500 (basis points: 500 = 5%, 550 = 5.5%; 0–10000).
- `campaign_affiliates.override_bps` INTEGER NULL — what THIS person earns on their downline. NULL = campaign default.
- `override_earnings.override_bps`, `payout_override_items.override_bps` INTEGER NULL — the % the row was priced at.
  NULL on rows priced under v4 (those keep their `cpm_diff_cents`); v5 rows store `cpm_diff_cents = 0`.
```
effective_override_bps = COALESCE(campaign_affiliates.override_bps, campaigns.default_override_bps)
for each priced week with week_cents > 0 (the poster's own pay, §3, after caps), walk up the poster's
upline chain (removed uplines are skipped):
  each upline earns floor(week_cents × their effective_override_bps / 10000)
→ every level earns its OWN % of the poster's pay; 0% earns $0. It's paid ON TOP: the poster's pay is never reduced.
Nothing paid to the poster (e.g. below min_views_to_qualify) → no overrides. Overrides count toward total_budget_cents,
oldest week first, alongside own earnings — but NOT toward max_payout_per_affiliate_cents (that only caps a
person's own posted videos). Once priced, an override is permanent, same as own earnings (§3): changing a %
only affects weeks priced after the change.

override_earned_cents = Σ override_earnings.amount_cents   (no more locked/approved split — always earned once priced)
owed_cents             = earned_cents + override_earned_cents − paid_cents
```
Example: rookie at $1.50 CPM, upline at 5%. The rookie's 10K new views this week pay the rookie $15.00 and the upline 5% of that, $0.75, on top.

### API additions
- `CampaignSummary` / `CampaignDetail` add: `rank`, `override_earned_cents`, and (v5) `override_bps` — the caller's effective override %.
- `Earnings` adds: `override_earned_cents` (top level and in each `by_campaign` row). `owed_cents` uses the formula above.
- `Payout` adds `override_items: [ { video_id, campaign_id, campaign_name, canonical_url, from_name, billable_views, cpm_diff_cents, amount_cents, week_of, override_bps, from_earned_cents } ]`. `from_name` = the downline member who posted. v5 rows: `override_bps` = the % and `from_earned_cents` = what the poster was paid that week (`amount_cents` = that % of it); both null on v4 rows, which show `cpm_diff_cents` instead. `amount_cents` of the payout = Σ line_items + Σ override_items.
- New: `GET /campaigns/:id/team` → `{ ok, team: TeamNode }`: the caller and their downline only (never their upline, never contact details).
```jsonc
// TeamNode (the root is the caller, level 0)
{ "id", "name", "rank", "cpm_rate_cents", "override_bps", "status", "level", "video_count", "total_views",
  "your_override_earned_cents",   // what the CALLER earned from this person's own videos (0 on the root)
  "downline": [ TeamNode ] }
```
Errors: same as `GET /campaigns/:id` (`not_found` when not assigned).

## 7. View screenshots (added in v6, additive only)
Trial reels (and some other posts) have no public view count, so the affiliate uploads a screenshot of their
insights screen and staff read the number off it during the weekly check (§3). Screenshots never change pay by
themselves — only the views staff enter do.

Table `video_screenshots` (migration `0023`): `id, video_id, creator_id, content_type, size_bytes, reported_views, note, uploaded_at`.
Images are stored in R2 under `video-screenshots/<id>`.

| method | path | body | returns |
|---|---|---|---|
| POST | /videos/:id/screenshots?views=&note= | raw image bytes, `Content-Type: image/png \| image/jpeg \| image/webp`, ≤ 10MB. `views` (optional) = the number the screenshot shows; `note` optional, ≤ 500 chars | `201 { ok, screenshot: Screenshot }` |
| GET | /videos/:id/screenshots | — | `{ ok, data: Screenshot[] }`, newest first |
| GET | /screenshots/:id | — | the image itself (needs the Bearer header, so fetch it as a blob) |
| DELETE | /screenshots/:id | — | `{ ok: true }`; `409 not_deletable` once staff have checked views after it was uploaded |

Upload is allowed only while the video is `pending_review` or `approved`; max 30 per video.
Error codes: `unsupported_image` (415), `image_too_large` (413), `video_not_tracking` (409), `too_many_screenshots` (409), `not_found`, `validation_error`.
```jsonc
// Screenshot
{ "id", "video_id", "content_type", "size_bytes", "reported_views", "note", "uploaded_at" }
```
`Video` adds `screenshot_count` and `last_screenshot_at`.

---

## 8. Instagram connections (added in v7, additive only)
Trial reels have no public view count. The affiliate's own token does have it — verified against a
live trial reel: it comes back from `/me/media` and its insights return a real `views` number, even
though the account's public `media_count` doesn't include it. Meta documents this neither way, so
it may change; screenshots (§7) remain the supported fallback and the only option for affiliates on
personal accounts.

**This is not v3's automated polling.** Nothing here prices a week, writes `view_snapshots`, or moves
money. The number is a *suggestion* that pre-fills the weekly entry box; a person still saves every
priced week, because priced weeks are permanent (§3).

Tables (migration `0024`):
`creator_instagram_connections`: `creator_id (PK), ig_user_id, username, access_token_encrypted,
token_expires_at, scopes, connected_at, last_refreshed_at, last_synced_at, last_error`.
`video_api_views`: `video_id (PK), ig_media_id, views, reach, likes, comments, fetched_at, error`.

| method | path | body | returns |
|---|---|---|---|
| GET | /connections | — | `{ ok, available, instagram: Connection }` |
| POST | /connections/instagram/start | — | `{ ok, authorize_url }`. Error code `not_configured` (503) when `IG_APP_ID` is unset |
| DELETE | /connections/instagram | — | `{ ok: true }`. Also drops that creator's cached `video_api_views` |

```jsonc
// Connection
{ "connected", "username", "connected_at", "last_synced_at", "expires_at", "needs_reconnect", "error" }
```

The OAuth return leg is `GET ${API_URL}/api/affiliate/instagram/callback`, **outside** the affiliate
prefix: it's a browser redirect from Instagram with no Bearer header, so the creator rides in a
signed, 15-minute `state` (HMAC under `AFFILIATE_ENCRYPTION_KEY`). It always redirects back to
`${PORTAL_URL}/settings.html?instagram=connected|denied|failed`, never returning JSON.

Scopes requested: `instagram_business_basic,instagram_business_manage_insights`. Instagram Login,
not Facebook Login — no linked Facebook Page is required. Long-lived tokens last ~60 days and cron
refreshes them 10 days out; a failed refresh records `last_error` and the portal asks the affiliate
to reconnect.

Matching a submitted URL to a post: Instagram has no shortcode lookup, so the Worker walks
`/me/media` and matches on the `permalink` shortcode against `videos.platform_video_id`. Strip the
`?stkn=` share token Instagram appends to trial reel links.

Staff see the number on the video detail modal as `apiViews`, pre-filled into Views with the note
`Instagram API — @handle, <when>`. Insights lag up to 48h, which is fine for a Sunday check.

---

## 9. Campaign applications (added in v8, additive only)

A campaign can have a **public application page**: one shareable link that pitches the campaign, shows
the site the creator would be promoting in an iframe, shows a few example videos, explains the pay in
plain words, and collects an application. Staff review applications in the CRM; approving one creates
(or matches) the creator, adds them to the campaign at the campaign's starting rate, and sends the
existing invite email from §5. Nothing above this section changes.

Two links, one page:
```
${PORTAL_URL}/apply.html?c=<public_slug>              ← the campaign's own link (staff share this)
${PORTAL_URL}/apply.html?c=<public_slug>&r=<ref_code> ← the same page, shared by a creator already on the roster
```

### New enums
```
application_status: new | reviewing | approved | declined | withdrawn
question_type:      short_text | long_text | select | multi_select | boolean | url | number
audience_size:      under_5k | 5k_25k | 25k_100k | 100k_500k | 500k_plus   (matches AUDIENCE_TIERS in worker/intake.js)
posting_cadence:    1_2_week | 3_5_week | 6_plus_week | not_sure
```

### D1 (migration `0025_campaign_applications.sql`)

**`campaigns` — ADD (all optional; edited on a new "Application" tab in the campaign drawer)**
| column | type | notes |
|---|---|---|
| application_enabled | INTEGER NOT NULL DEFAULT 0 | 0 = the public link 404s |
| public_slug | TEXT NULL | UNIQUE. `[a-z0-9-]{3,60}`, suggested from the name, editable. Changing it breaks links already sent — the CRM warns before saving |
| public_headline | TEXT NOT NULL DEFAULT '' | ≤ 120 chars |
| public_pitch | TEXT NOT NULL DEFAULT '' | ≤ 4000 chars. **Public.** `campaigns.brief` stays private and is never served by §9 — briefs routinely hold client names, hooks and do-not-say lists |
| brand_name | TEXT NOT NULL DEFAULT '' | what the applicant would be promoting. Falls back to `name` in copy |
| promo_url | TEXT NOT NULL DEFAULT '' | the site shown in the iframe. `https://` only |
| promo_embed | INTEGER NOT NULL DEFAULT 1 | 0 = the site refuses framing (`X-Frame-Options`/CSP) → show the fallback card instead. Staff toggle it; the CRM pre-checks on save and suggests the value |
| promo_image_url | TEXT NOT NULL DEFAULT '' | fallback screenshot for `promo_embed = 0` |
| application_questions | TEXT NOT NULL DEFAULT '[]' | JSON `Question[]`, max 10 |
| application_seats | INTEGER NULL | once this many applications are `approved`, the page closes itself |
| application_closes_at | TEXT NULL | `YYYY-MM-DD`, inclusive |

**Starting pay is not a new column.** `campaigns.default_cpm_rate_cents` *is* the starting rate the page
advertises, and `campaigns.default_override_bps` is the team bonus. Approving an application inserts a
`campaign_affiliates` row with `cpm_rate_override_cents = NULL` and `rank = 'rookie'`, so a new creator
starts on exactly the number they were shown. Staff can type a different rate at the moment of approval.

**`campaign_example_videos`** (optional, max 6 per campaign)
`id TEXT PK, campaign_id TEXT NOT NULL → campaigns.id CASCADE, url TEXT NOT NULL, platform TEXT NOT NULL (platform),
platform_video_id TEXT NOT NULL, embed_url TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT '',
caption TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL`
Same URL parsing as `POST /videos` (§4), but these are *examples of the work*: never tracked, never paid,
and they don't collide with the `UNIQUE(platform, platform_video_id)` on `videos`.

**`creators` — ADD (this is where the company-wide side lives)**
| column | type | notes |
|---|---|---|
| ref_code | TEXT NULL | UNIQUE. 8 chars, Crockford base32, no vowels. Minted the first time the creator is approved onto any campaign |
| referred_by_creator_id | TEXT NULL → creators.id | **Company-wide and set once**, from the `r=` on the link they applied through. Only staff can change it afterwards; self-reference and cycles rejected |
| referred_at | TEXT NULL | |

**`campaign_applications`**
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| campaign_id | TEXT NOT NULL → campaigns.id CASCADE | |
| status | TEXT NOT NULL DEFAULT 'new' | application_status |
| name / email / phone / phone_e164 / country | TEXT | `email` lowercased. UNIQUE(campaign_id, email COLLATE NOCASE) |
| instagram / tiktok / youtube / portfolio_url | TEXT NOT NULL DEFAULT '' | free text, normalized for comparison like `creators` |
| platforms | TEXT NOT NULL DEFAULT '[]' | JSON array of platform, subset of the campaign's `platforms_allowed` |
| audience_size | TEXT NOT NULL DEFAULT '' | audience_size enum |
| posting_cadence | TEXT NOT NULL DEFAULT '' | posting_cadence enum |
| niches | TEXT NOT NULL DEFAULT '[]' | JSON array |
| why | TEXT NOT NULL DEFAULT '' | ≤ 1000 chars |
| answers | TEXT NOT NULL DEFAULT '{}' | JSON, keyed by `Question.id` |
| ref_code | TEXT NULL | exactly what was on the link |
| referred_by_creator_id | TEXT NULL → creators.id | resolved at submit time, so a later `ref_code` change can't rewrite history |
| creator_id | TEXT NULL → creators.id | matched on submit if the email is already a creator; set on approval otherwise |
| campaign_affiliate_id | TEXT NULL → campaign_affiliates.id | set on approval |
| consent | INTEGER NOT NULL DEFAULT 0 | must be 1 |
| age_confirmed | INTEGER NOT NULL DEFAULT 0 | must be 1 (18+) |
| utm | TEXT NOT NULL DEFAULT '{}' | JSON |
| page_url / referrer / user_agent | TEXT NOT NULL DEFAULT '' | |
| ip_hash | TEXT NOT NULL DEFAULT '' | sha256(ip + `AFFILIATE_ENCRYPTION_KEY`). Rate limiting only; the raw IP is never stored |
| review_notes | TEXT NOT NULL DEFAULT '' | staff-only |
| decline_reason | TEXT NOT NULL DEFAULT '' | staff-only unless a decline email is sent |
| submitted_at / created_at / updated_at | TEXT NOT NULL | |
| reviewed_at | TEXT NULL | |
| reviewed_by | TEXT NULL → users.id | |

Applications are **not** creators. A row here appears nowhere in the Creators list, in `campaign_affiliates`,
or in any earnings figure until someone approves it.

### Where the company-wide side meets a campaign
`creators.referred_by_creator_id` is the lifetime, company-wide relationship — one per creator.
`campaign_affiliates.upline_id` stays exactly as §6 defines it, per campaign. On approval the CRM
**derives** the campaign upline: walk up the applicant's company-wide chain and take the first person
who has a non-`removed` assignment on *this* campaign; if nobody in the chain is on it, `upline_id = NULL`.
The referrer is never auto-added to a campaign, and staff can always set `uplineId` by hand at approval.
Override pricing (§6) is unchanged: a team bonus only exists where a campaign upline exists.

### Public API — `${API_URL}/api/public/v1` (no auth, no session, no Bearer)
Served by a new `worker/public-campaigns.js`, outside the `/api/affiliate/v1` prefix so nothing there
loses its auth check. CORS: `GET` and `POST` from the portal origins already in `ALLOWED_ORIGINS`.

| method | path | body | returns |
|---|---|---|---|
| GET | /campaigns/:slug?ref=CODE | — | `{ ok, campaign: PublicCampaign }`. `404 not_found` when the slug is unknown, `application_enabled = 0`, or the campaign is `draft`/`ended`. `410 applications_closed` past `application_closes_at`, past `application_seats`, or while `paused` |
| POST | /campaigns/:slug/applications | `ApplicationInput` | `201 { ok, status: "received" }` — nothing else, ever |

Error codes: `not_found` (404), `validation_error` (400), `already_applied` (409),
`applications_closed` (410), `rate_limited` (429 — 5 per IP-hash per hour, 3 per email per hour).

**Never served here:** `brief`, any budget or cap, `funded_by`, affiliate names or counts, other
applications, anything about earnings. The referrer is exposed as a first name only, and only when
`ref` matches a live creator.

```jsonc
// PublicCampaign
{ "slug", "name", "brand_name", "headline", "pitch", "status",
  "platforms_allowed", "currency",
  "starting_cpm_rate_cents",      // = campaigns.default_cpm_rate_cents
  "team_bonus_bps",               // = campaigns.default_override_bps
  "min_views_to_qualify",
  "requires_video_approval",
  "start_date", "end_date", "closes_at",
  "promo_url", "promo_embed", "promo_image_url",
  "example_videos": [ { "url", "platform", "embed_url", "thumbnail_url", "caption" } ],
  "questions": [ Question ],
  "referrer_first_name",          // null unless ?ref= matched
  "ref_code" }                    // echoed back, or null

// Question
{ "id",                 // [a-z0-9_]{1,40}, stable — it's the key in `answers`
  "label", "type",      // question_type
  "required",           // bool
  "help",               // '' or a line under the field
  "options",            // [] unless select / multi_select
  "max_length" }        // null, or a cap for short_text / long_text

// ApplicationInput  (the portal sends exactly these keys; unknown keys are rejected)
{ "name", "email", "phone", "country",
  "instagram", "tiktok", "youtube", "portfolio_url",
  "platforms": ["tiktok"], "audience_size", "posting_cadence", "niches": [],
  "why", "answers": { "<question_id>": <value> },
  "consent": true, "age_confirmed": true,
  "ref_code", "utm": {}, "page_url", "referrer" }
```
Required: `name`, `email`, at least one handle among `instagram`/`tiktok`/`youtube`, at least one
`platforms` entry, `consent`, `age_confirmed`, plus every `Question` with `required: true`.
`already_applied` comes back for a repeat email on the same campaign whatever the first one's status —
the message says it's already in, it never hints at the decision.

### Admin API additions (camelCase, like the rest of the admin API)
| method | path | notes |
|---|---|---|
| GET | /api/campaigns/:id/applications?status= | `{ ok, applications: Application[] }`, newest first |
| PATCH | /api/campaign-applications/:id | `{ status, reviewNotes, declineReason }` — `reviewing`, `declined`, or back to `new`. Approving goes through the endpoint below |
| POST | /api/campaign-applications/:id/approve | `{ cpmRateOverrideCents?, overrideBps?, rank?, uplineId?, sendInvite? }` → `{ ok, application, affiliate, creator, inviteSent, inviteError }` |
| POST | /api/campaigns/:id/example-videos | `{ url, caption }` → `201 { ok, exampleVideo }` |
| PATCH | /api/campaign-example-videos/:id | `{ caption, sortOrder }` |
| DELETE | /api/campaign-example-videos/:id | |

The application config itself rides on the existing `PATCH /api/campaigns/:id` as new camelCase keys:
`applicationEnabled, publicSlug, publicHeadline, publicPitch, brandName, promoUrl, promoEmbed,
promoImageUrl, applicationQuestions, applicationSeats, applicationClosesAt`.
`GET /api/campaigns/:id` adds those plus `exampleVideos`, `applicationCounts: { new, reviewing, approved, declined }`,
and `publicUrl`.

**Approve does, in one batch:** match `creators` on email (case-insensitive) or create one with
`source: 'campaign_application'`, `roster_status: 'approved'`, `form_status: 'complete'`, `consent: 1`;
fill blank creator handles from the application, never overwrite filled ones; set
`referred_by_creator_id`/`referred_at` only if still NULL; mint `ref_code` if missing; derive
`upline_id` as above; insert the `campaign_affiliates` row exactly as `POST /api/campaigns/:id/affiliates`
does today (`status: 'invited'`, rank `rookie`, no rate override unless one was typed); set the
application to `approved` with `reviewed_at`/`reviewed_by`; write `affiliate_audit_log` rows
`application_approved` and `affiliate_added`; then send the existing invite email unless
`sendInvite: false`. A failed email never rolls back the approval — it comes back as `inviteError`,
exactly like `addAffiliate`.

### Affiliate API additions (`/api/affiliate/v1`, for the signed-in portal)
- `CampaignSummary` / `CampaignDetail` add `share_url` — `${PORTAL_URL}/apply.html?c=<slug>&r=<ref_code>`,
  or `null` when that campaign has no live application page — and `team_bonus_bps`, an alias of the §6
  `override_bps` the caller earns, so the sharing card and the public page print the same number.
- `Creator` adds `ref_code`.
- No new endpoints. Sharing is a link, not an action: an affiliate can't add anyone, every application
  still goes through staff review.

### The pay explainer (identical words on both sides)
The public page, the invite email and the portal describe pay the same way. Both agents render this from
the same variables instead of each writing their own version:

```
{{starting_cpm}}      money, from starting_cpm_rate_cents        e.g. "$1.50"
{{team_bonus}}        percent, from team_bonus_bps               e.g. "5%"
{{brand}}             brand_name || name
{{platforms}}         platforms_allowed, prose list              e.g. "TikTok, Instagram or YouTube"
{{min_views}}         min_views_to_qualify, or null
{{referrer_first}}    referrer_first_name, or null
```

> **How you get paid**
> You post about {{brand}} on {{platforms}}. Every Sunday we count the new views each of your videos
> picked up that week, and you're paid {{starting_cpm}} for every 1,000 of them. A video keeps earning
> every week for as long as the campaign is running — there's no cut-off date and no limit on how many
> videos you post.
>
> **{{starting_cpm}} per 1,000 views is where everyone starts.** As your videos deliver, your rate goes
> up with your level — Rookie, General, Master, Top Creator. Levels are set by Edgeform across every
> campaign you're on, not campaign by campaign, so a raise you earn here follows you to the next one.
>
> **Bring other creators in and you earn a {{team_bonus}} team bonus** on what they're paid for their own
> views, for as long as they're posting. Edgeform pays it on top of their pay — their rate is never
> reduced to fund yours, and you earn it on their *views*, never on them signing up. There's no fee to
> apply and nothing to buy, now or later.

Rules for any copy written on top of this: it's a **creator roster with levels and a team bonus**.
Never "pyramid", "downline", "recruits", "levels deep", "passive income", "unlimited earnings", or any
figure the person hasn't actually earned. Never promise a level-up on a timeline. `funded_by`, budgets
and caps stay out of every public word.

### Who builds what (§9)
| CRM agent (`edgeform-crm`) | Portal agent (`affiliate.edgeformmarketing.com`) |
|---|---|
| Migration `0025`, the two new tables, the three `creators` columns | `apply.html` — public, no session, no header/nav shell |
| Application tab in the campaign drawer: toggle, slug + copy-link, headline/pitch, brand, promo URL with framing pre-check, promo image, example videos, question editor, seats, closing date | Hero, pay explainer, iframe with the fallback card, example-video cards, the form, the "we'll email you" success state |
| Applications list with a `new` badge, filters, detail view, Approve / Decline / notes | Client-side validation matching §9, one plain-language message per error code |
| `worker/public-campaigns.js`, rate limiting, `already_applied`, slug uniqueness | Sharing card on `campaign.html`: the affiliate's `share_url`, a copy button, one line on the team bonus |
| Approval → creator + `campaign_affiliates` + derived upline + invite email + audit rows | `mock-api.js` covers `/api/public/v1` too, so `apply.html?mock=1` works with no CRM |
| Decline email (optional, staff-typed reason) | Mobile first: most applicants open this link on a phone, inside TikTok's or Instagram's in-app browser |
