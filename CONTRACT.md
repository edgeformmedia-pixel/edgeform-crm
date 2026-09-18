# Edgeform Affiliate System — Shared Contract (v4)

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

### Override formula (v4: priced per week, alongside the poster's own earnings in §3)
```
for each priced week, walk up the poster's upline chain (removed uplines are skipped):
  highest = poster's effective CPM
  for each upline: diff = upline CPM − highest; if diff > 0 the upline earns floor(delta_views × diff / 1000)
                   highest = max(highest, upline CPM)
→ equal (or lower) CPM earns $0; everything paid on a week adds up to the highest CPM in its chain
min_views_to_qualify applies to overrides too (cumulative, per §3); overrides count toward total_budget_cents,
oldest week first, alongside own earnings — but NOT toward max_payout_per_affiliate_cents (that only caps a
person's own posted videos). Once priced, an override is permanent, same as own earnings (§3).

override_earned_cents = Σ override_earnings.amount_cents   (no more locked/approved split — always earned once priced)
owed_cents             = earned_cents + override_earned_cents − paid_cents
```
Example: rookie at $1.50, upline at $2.00. The rookie's 1K new views this week pay the rookie $1.50 and the upline $0.50. The upline's own 1K views pay the upline $2.00.

### API additions
- `CampaignSummary` / `CampaignDetail` add: `rank`, `override_earned_cents`.
- `Earnings` adds: `override_earned_cents` (top level and in each `by_campaign` row). `owed_cents` uses the formula above.
- `Payout` adds `override_items: [ { video_id, campaign_id, campaign_name, canonical_url, from_name, billable_views, cpm_diff_cents, amount_cents, week_of } ]`. `from_name` = the downline member who posted. `amount_cents` of the payout = Σ line_items + Σ override_items.
- New: `GET /campaigns/:id/team` → `{ ok, team: TeamNode }`: the caller and their downline only (never their upline, never contact details).
```jsonc
// TeamNode (the root is the caller, level 0)
{ "id", "name", "rank", "cpm_rate_cents", "status", "level", "video_count", "total_views",
  "your_override_earned_cents",   // what the CALLER earned from this person's own videos (0 on the root)
  "downline": [ TeamNode ] }
```
Errors: same as `GET /campaigns/:id` (`not_found` when not assigned).
