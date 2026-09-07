# Content Generation Studio

Turns a PDF or a short course description into a fully built course in a
GoHighLevel sub-account — modules, lessons, lesson content,
downloadable workbooks, an optional 3-step sales funnel, and (on a paid Gemini
project) AI thumbnails. Connected to the sub-account through a **Private
Integration** token; no marketplace app or OAuth required.

AI provider: **Google Gemini** (text + Nano Banana images).

---

## Setup

### 1. Create a Private Integration in the sub-account
In the sub-account: Settings → Private Integrations → **+ Create**. Scopes:

```
courses.readonly  courses.write
medias.readonly   medias.write
locations.readonly
locations/customValues.readonly  locations/customValues.write
```
(add `products.*` if the screen offers them). Copy the `pit-…` token.

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

Minimum env:
```
GHL_PIT_TOKEN=pit-...
GHL_LOCATION_ID=<sub-account id from the URL>
GEMINI_API_KEY=...
AI_IMAGES=off            # remove once on a paid Gemini project
```

---

## Deploying on Render

1. Push this repo to GitHub and create a **Web Service** from it (Node, `npm start`).
2. Add the env vars above under **Environment**.
3. Do **not** set `DATABASE_URL` or the `GHL_CLIENT_*` / `GHL_OAUTH_*` vars — those switch the app
   into multi-tenant marketplace mode and need a Postgres database.

The `.onrender.com` URL follows the service name (Settings → General → Name).

---

## Env reference

| Variable | Default | Purpose |
|---|---|---|
| `GHL_PIT_TOKEN` | — | Private Integration token |
| `GHL_LOCATION_ID` | — | Sub-account ID (server-side fallback only; the form no longer pre-fills it) |
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
  install and are not available in Private Integration mode.
- Everything AI lives in `lib/gemini.js` plus the five `lib/generate-*.js` modules.
