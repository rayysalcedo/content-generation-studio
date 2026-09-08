# Content Generation Studio

Turns a PDF or a short course description into a fully built course in a
GoHighLevel sub-account — modules, lessons, lesson content,
downloadable workbooks, an optional 3-step sales funnel, and (on a paid Gemini
project) AI thumbnails.

Connects to GoHighLevel in one of two ways:

| Mode | Best for | Needs |
|---|---|---|
| **Private Integration (PIT)** | One sub-account, quickest setup | A `pit-…` token |
| **OAuth marketplace app** | Multiple sub-accounts, snapshot push, funnel share-to-locations | A Marketplace app + Postgres |

Both can be set at once — OAuth is tried first for each sub-account and the PIT is the fallback.

AI provider: **Google Gemini** (text + Nano Banana images).

---

## Setup

### 1. Choose an auth mode

#### Option A — Private Integration (single sub-account)
In the sub-account: Settings → Private Integrations → **+ Create**. Scopes:

```
courses.readonly  courses.write
medias.readonly   medias.write
locations.readonly
locations/customValues.readonly  locations/customValues.write
```
(add `products.*` if the screen offers them). Copy the `pit-…` token and set:

```
GHL_PIT_TOKEN=pit-...
GHL_LOCATION_ID=<sub-account id from the URL>
```

#### Option B — OAuth marketplace app (multi-tenant)
1. Go to https://marketplace.gohighlevel.com → **My Apps → Create App**.
2. Distribution type: **Sub-Account** (also enable **Agency** if you want snapshot push / funnel share).
3. Under **Scopes**, add:
   ```
   courses.readonly  courses.write
   medias.readonly   medias.write
   locations.readonly
   snapshots.readonly  snapshots.write   # only if Agency distribution is enabled
   ```
4. Under **Redirect URLs**, add `https://<your-domain>/oauth/callback`
   (`http://localhost:3000/oauth/callback` for local dev).
5. Generate client credentials and set:
   ```
   GHL_CLIENT_ID=...
   GHL_CLIENT_SECRET=...
   GHL_OAUTH_REDIRECT_URI=https://<your-domain>/oauth/callback
   DATABASE_URL=postgres://...      # token store; see note below
   ```
6. Start the app and open `/oauth/install`. Pick the sub-account (or agency) to install into;
   tokens are stored per sub-account and refreshed automatically. Repeat for each sub-account.

Without `DATABASE_URL` the token store falls back to `data/installations.json` — fine locally,
but on Render the disk is wiped on every deploy, so use a Postgres instance there.

### 2. Get a Gemini API key
https://aistudio.google.com/apikey

- **Free tier** — text models are free. Image models are **not** available; set `AI_IMAGES=off`.
- **Paid tier** — link a billing account in AI Studio to enable images (≈ $0.03–0.07 per image).

### 3. Configure
```bash
cp .env.example .env     # then fill in the values
npm install
npm start                # http://localhost:3000
```

Minimum env (PIT mode):
```
GHL_PIT_TOKEN=pit-...
GHL_LOCATION_ID=<sub-account id from the URL>
GEMINI_API_KEY=...
AI_IMAGES=off            # remove once on a paid Gemini project
```

---

## Deploying on Render

1. Push this repo to GitHub and create a **Web Service** from it (Node, `npm start`).
2. Add the env vars for your auth mode under **Environment**.
3. **OAuth mode only:** create a Render **PostgreSQL** instance, copy its *Internal Database URL*
   into `DATABASE_URL`, and set `GHL_OAUTH_REDIRECT_URI` to `https://<service>.onrender.com/oauth/callback`
   (the same URL must be in the Marketplace app's Redirect URLs). Leave `DATABASE_URL` unset in
   PIT mode — a bad value will crash-loop the service.

The `.onrender.com` URL follows the service name (Settings → General → Name).

---

## Env reference

| Variable | Default | Purpose |
|---|---|---|
| `GHL_PIT_TOKEN` | — | **PIT mode.** Private Integration token |
| `GHL_LOCATION_ID` | — | **PIT mode.** Sub-account ID (server-side fallback only; the form no longer pre-fills it) |
| `GHL_CLIENT_ID` | — | **OAuth mode.** Marketplace app client ID |
| `GHL_CLIENT_SECRET` | — | **OAuth mode.** Marketplace app client secret |
| `GHL_OAUTH_REDIRECT_URI` | — | **OAuth mode.** `https://<domain>/oauth/callback` |
| `GHL_OAUTH_SCOPES` | see `.env.example` | **OAuth mode.** Space-separated scopes requested at install |
| `DATABASE_URL` | — | **OAuth mode.** Postgres connection string for the token store (falls back to a local JSON file) |
| `GHL_APP_ORIGIN` | `https://app.gohighlevel.com` | Your platform's web-app origin (set for white-label domains) |
| `GEMINI_API_KEY` | — | Gemini key |
| `GEMINI_TEXT_MODEL` | `gemini-3.7-flash` | Course / workbook / funnel copy |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Thumbnails + funnel images |
| `GEMINI_IMAGE_SIZE` | `1K` | `512` · `1K` · `2K` · `4K` |
| `AI_IMAGES` | `on` | `off` = skip all image generation |
| `AI_WORKBOOK_CONCURRENCY` | `6` | Lower to ~3 on the free tier |
| `AI_WORKBOOK_DELAY_MS` | `400` | Raise to ~20000 on the free tier |
| `AI_IMAGE_CONCURRENCY` | `3` | Parallel image calls |
| `REGEN_LIMIT` | `3` | Regenerations per sub-account |
| `GHL_USER_JWT` | — | Browser session JWT, only for the thumbnail-attach step |

---

## Notes

- **Thumbnail attach** uses the platform's internal `backend.leadconnectorhq.com` API with a
  browser session JWT that expires hourly (paste it at `/setup`). Course creation
  itself uses the public import API and does not need it.
- **Snapshot push** and **funnel share-to-locations** require an agency-level OAuth
  install (Marketplace app with Agency distribution + `snapshots.write`) and are not
  available in Private Integration mode.
- **Auth resolution order:** for each sub-account the app tries a stored OAuth install first,
  then falls back to `GHL_PIT_TOKEN`. `/api/config` reports which mode is active.
- Everything AI lives in `lib/gemini.js` plus the five `lib/generate-*.js` modules.
