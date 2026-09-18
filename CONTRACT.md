# Edgeform Affiliate System — Shared Contract (v2)

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
view_source:        api | oauth | scraper | manual
payout_status:      pending | approved | paid | failed
payout_method:      paypal | wise | bank | manual
flag_type:          handle_mismatch | fetch_failed | video_unavailable | suspicious_spike
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
| view_tracking_window_days | INTEGER NOT NULL DEFAULT 30 | |
| min_views_to_qualify | INTEGER NULL | |
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

### creator_platform_connections (OAuth for TikTok and Instagram, built in phase 4)
| column | type |
|---|---|
| id | TEXT PK |
| creator_id | TEXT NOT NULL → creators.id CASCADE |
| platform | TEXT NOT NULL (UNIQUE with creator_id) |
| platform_user_id | TEXT NOT NULL |
| platform_username | TEXT NOT NULL |
| access_token_encrypted | TEXT NOT NULL |
| refresh_token_encrypted | TEXT NULL |
| token_expires_at | TEXT NULL |
| connected_at | TEXT NOT NULL |
| revoked_at | TEXT NULL |

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
| tracking_ends_at | TEXT NOT NULL | submitted_at + view_tracking_window_days |
| locked_at | TEXT NULL | |
| latest_view_count | INTEGER NOT NULL DEFAULT 0 | |
| billable_views | INTEGER NOT NULL DEFAULT 0 | frozen when the video locks |
| earned_cents | INTEGER NOT NULL DEFAULT 0 | cached, can always be recomputed |
| last_fetched_at | TEXT NULL | |
| next_fetch_at | TEXT NULL | used by the scheduled job |
| consecutive_fetch_failures | INTEGER NOT NULL DEFAULT 0 | |

### view_snapshots (append-only, never update or delete)
`id TEXT PK, video_id TEXT NOT NULL → videos.id CASCADE, view_count INTEGER NOT NULL, like_count INTEGER NULL, comment_count INTEGER NULL, source TEXT NOT NULL (view_source), fetched_at TEXT NOT NULL, raw_response TEXT NULL (JSON), entered_by TEXT NULL → users.id, note TEXT NULL`

### video_flags
`id TEXT PK, video_id TEXT NOT NULL → videos.id CASCADE, type TEXT NOT NULL (flag_type), details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, resolved_at TEXT NULL, resolved_by TEXT NULL → users.id`

### payouts
`id TEXT PK, creator_id TEXT NOT NULL → creators.id, period_start TEXT, period_end TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'pending' (payout_status), payment_method TEXT NULL (payout_method), payment_reference TEXT NULL, paid_at TEXT NULL, created_by TEXT NULL → users.id, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`

### payout_line_items
`id TEXT PK, payout_id TEXT NOT NULL → payouts.id CASCADE, video_id TEXT NOT NULL → videos.id, campaign_id TEXT NOT NULL, billable_views INTEGER NOT NULL, cpm_rate_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL`
A video is paid at most once: UNIQUE(video_id).

### affiliate_login_tokens
`token_hash TEXT PK (sha256), creator_id TEXT NOT NULL → creators.id CASCADE, expires_at TEXT NOT NULL (15 min), used_at TEXT NULL, created_at TEXT NOT NULL`

### affiliate_sessions (kept separate from the CRM staff `sessions` table)
`token_hash TEXT PK (sha256), creator_id TEXT NOT NULL → creators.id CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL (30 days)`

### affiliate_audit_log
`id TEXT PK, actor_type TEXT NOT NULL ('user' | 'creator' | 'system'), actor_id TEXT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NULL, after_json TEXT NULL, created_at TEXT NOT NULL`
Log: rate changes, manual view entries, approvals and rejections, payout status changes, and changes to payout details.

---

## 3. Formulas (only the CRM computes these; the portal just displays them)
```
earning_statuses = approved, locked       (everything else earns 0)
views            = status == locked ? billable_views : latest_view_count
if min_views_to_qualify is set and views < min_views_to_qualify → 0
raw_cents        = floor(views * effective_cpm_rate_cents / 1000)
video_cents      = min(raw_cents, max_payout_per_video_cents ?? ∞)
then cap the creator's total in the campaign at max_payout_per_affiliate_cents (oldest videos fill first)
then cap all creators in the campaign at total_budget_cents (oldest videos fill first)
→ store the result in videos.earned_cents

earned_cents   (per creator) = Σ earned_cents of locked videos
pending_cents                = Σ earned_cents of approved videos that aren't locked yet ("estimated, still counting")
paid_cents                   = Σ payouts.amount_cents where status = paid
owed_cents                   = earned_cents − paid_cents
```

### Polling (runs inside the existing every-minute `scheduled()` as `affiliateViewsCron(env)`)
- Each tick picks up to 25 videos with status `approved`, `next_fetch_at <= now`, and `tracking_ends_at > now`.
- Schedule: every 6 hours for the first 72 hours after submission, then every 24 hours.
- Once `tracking_ends_at` has passed: take a final fetch, then set `billable_views = latest_view_count`, `status = locked`, `locked_at = now`, and recompute earnings.
- 3 failures in a row → add a `fetch_failed` flag. If the video is deleted or private → status `removed` and a `video_unavailable` flag. Never zero out earnings automatically.
- If views jump more than 300% in 24 hours while likes grow less than 0.5% of the new views → add a `suspicious_spike` flag.
- Providers: YouTube Data API v3 (`YOUTUBE_API_KEY` secret), TikTok and Instagram through OAuth, with Apify as the fallback (`APIFY_TOKEN` secret). Choose the provider per platform with vars `VIEW_PROVIDER_TIKTOK`, `VIEW_PROVIDER_INSTAGRAM` = `oauth` | `scraper`.

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

### Platform connections (phase 4. Until then `GET` returns `data: []` and `/start` returns `501` with code `not_available`)
| GET | /connections | → `{ ok, data: [{ platform, platform_username, connected_at }] }` |
| POST | /connections/:platform/start | → `{ ok, authorize_url }`. The portal sends the browser to that URL |
| DELETE | /connections/:platform | → `{ ok: true }` |
The OAuth callback lands on the Worker, which then redirects to `https://affiliate.edgeformmarketing.com/settings.html?connected=<platform>` or `?error=<code>`.

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
  "video_count", "total_views", "earned_cents", "pending_cents" }

// CampaignDetail = CampaignSummary plus
{ "brief", "view_tracking_window_days", "min_views_to_qualify",
  "max_payout_per_video_cents", "requires_video_approval" }

// Video
{ "id", "campaign_id", "submitted_url", "canonical_url", "platform", "thumbnail_url", "caption",
  "posted_at", "status", "rejection_reason", "submitted_at", "tracking_ends_at", "locked_at",
  "latest_view_count", "billable_views", "earned_cents", "last_fetched_at" }

// Earnings
{ "currency", "earned_cents", "pending_cents", "paid_cents", "owed_cents",
  "by_campaign": [ { "campaign_id", "campaign_name", "earned_cents", "pending_cents", "paid_cents", "owed_cents" } ] }

// Payout
{ "id", "period_start", "period_end", "amount_cents", "currency", "status", "payment_method",
  "payment_reference", "paid_at",
  "line_items": [ { "video_id", "campaign_id", "campaign_name", "canonical_url", "billable_views", "cpm_rate_cents", "amount_cents" } ] }
```
Never sent to the portal: creator notes, `roster_status`, `payout_details_encrypted`, OAuth tokens, `raw_response`, flags, audit log, other creators' data.

---

## 5. Who builds what
| CRM agent (`edgeform-crm`) | Portal agent (`affiliate.edgeformmarketing.com`) |
|---|---|
| Migrations for §2 | Static site: `index.html` (login), `verify.html`, `dashboard.html`, `campaign.html?id=`, `payouts.html`, `settings.html` |
| Campaigns section on marketing operations (Email tab placeholder, Affiliate tab) | Magic-link login and session in localStorage |
| Add affiliate: choose from Creators, or create one inline (which adds them to Creators) + invite email | Campaign list and detail pages |
| "Assigned to" column and campaign filter on the Creators list | Add Video flow, with a clear message for every error code |
| `worker/affiliate.js` serving all of §4 | Video table: status, views, earnings, tracking countdown |
| URL parsing, short-link resolving, duplicate check | Earnings dashboard and payout history |
| View providers + `affiliateViewsCron` + earnings calculation + locking + flags | Settings: profile, payout method, Connect TikTok/Instagram |
| Admin: video review queue, flags, manual view entry, payouts, CSV export, audit log | `mock-api.js` that follows §4 exactly, turned on with `?mock=1`, so the portal can be built before the CRM API is live |

**Sync point:** once the CRM's `/api/affiliate/v1` is deployed, the portal's `API_BASE` in `config.js` points at it and nothing else changes.
