# CC360 PDF → Course Builder (Local Test)

Takes a PDF, runs it through Gemini AI, and builds a fully populated course in CourseCreator360 with **zero clicks in the CC360 UI**.

## What it does

1. Reads a PDF from disk and extracts the text
2. Sends the text to Gemini AI to generate a structured course outline (modules + lessons + HTML body content)
3. Creates a brand-new course in your CC360 sub-account
4. Creates every module
5. Creates every lesson, populated with HTML content, and publishes it
6. Prints the live course URL

Total runtime for a typical PDF: **30-90 seconds**.

---

## Setup (one-time, ~5 minutes)

### 1. Install Node.js
You need Node.js 18 or higher. Check with `node --version`.
If you don't have it, install from https://nodejs.org

### 2. Install dependencies
```bash
cd cc360-builder
npm install
```

### 3. Get a Gemini API key (free)
1. Visit https://aistudio.google.com/app/apikey
2. Sign in with a Google account
3. Click **Create API Key** → copy it

### 4. Configure environment
```bash
cp .env.example .env
```
Then open `.env` in any text editor and fill in:

- **CC360_JWT** — your auth token (instructions below)
- **CC360_LOCATION_ID** — already filled in for your test sub-account
- **CC360_USER_ID** — already filled in
- **GEMINI_API_KEY** — paste the key from step 3

### 5. Capturing the JWT (you'll redo this every ~1 hour)
JWTs expire hourly. Here's the fastest way to grab a fresh one:

1. Open CourseCreator360 in Chrome → log in
2. Press `F12` → open the **Network** tab
3. Click around inside any course (loads some API calls)
4. Click any request to `backend.leadconnectorhq.com`
5. In the **Headers** tab, find `authorization: Bearer eyJ...`
6. Copy everything after `Bearer ` (just the token, not the word "Bearer")
7. Paste into `.env` as the value of `CC360_JWT`

---

## Running it

```bash
node build-course.js path/to/your-course.pdf "Course Title" "Target Audience" "Optional instructions"
```

### Examples

Minimal:
```bash
node build-course.js sample.pdf
```

With metadata:
```bash
node build-course.js real-estate-guide.pdf "Real Estate 101" "First-time buyers"
```

With special instructions:
```bash
node build-course.js coaching.pdf "Mindset Mastery" "Aspiring entrepreneurs" "Keep tone conversational, include action steps in each lesson"
```

### What you'll see

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CC360 PDF → Course Builder
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PDF:        /Users/.../real-estate-guide.pdf
 Title:      Real Estate 101
 ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📄 Reading PDF: real-estate-guide.pdf
   Extracted 12,453 characters from 18 pages
🤖 Generating course structure with Gemini (gemini-2.0-flash)...
   Generated 5 modules, 19 lessons total
   💾 Saved generated structure to ./last-structure-1730000000000.json

🏗️  Building course in CC360...
📦 Creating course: "Real Estate 101"
   ✓ Course created → productId: abc123-def...
   📁 Module created [0]: "Foundations of Real Estate" → mod1...
      📝 Lesson created [0]: "What is Real Estate Investing"
      📝 Lesson created [1]: "Common Misconceptions"
      ...
   📁 Module created [1]: "Finding Your First Property" → mod2...
      ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ✅ DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Course ID:   abc123-def...
 Time:        47.3s
 Open it:     https://app.coursecreator360.com/v2/location/.../product_id=abc123-def...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Click the printed URL → you'll land in your fully built course.

---

## Troubleshooting

### `401 Unauthorized`
Your JWT expired. Grab a fresh one from DevTools (see step 5 above) and update `.env`.

### `PDF text is suspiciously short`
The PDF is image-based (scanned). The script can't read scanned PDFs without OCR. Convert to a text-based PDF first, or add an OCR step (e.g., Tesseract or Google Document AI).

### `Gemini did not return valid JSON`
Rare, but happens when the source document is unusual. The script saves the raw response so you can inspect it. Just retry — Gemini is non-deterministic.

### `403 Forbidden` on POST
Your auth token is for a different sub-account than `CC360_LOCATION_ID`, or the token doesn't have the right scopes. Re-grab the JWT while logged into the correct sub-account.

### Runs but course is empty
Check the `last-structure-*.json` file that gets saved each run. If Gemini returned an empty or weird structure, the prompt might need tuning for your document type.

---

## What's saved per run

- `last-structure-{timestamp}.json` — the AI-generated course structure, useful for debugging or for fine-tuning the prompt

---

## Production considerations (read before pitching to your boss)

- **JWT auth is a hack.** This works because we reverse-engineered the internal CC360 API. For production multi-tenant use, we'll need either (a) automated JWT refresh via a headless browser, or (b) the official public Import Courses API once GHL fully documents it.
- **Rate limits** are unknown for these internal endpoints. The script adds a 150ms pause between lessons to be polite. If you build hundreds of courses in a day, monitor for rate limiting.
- **The endpoints are not officially supported.** GHL could change them without notice. Building a paid product on top of this is risky without a fallback path.

For your test/demo: this script is more than enough to prove the value to your boss. ✅
