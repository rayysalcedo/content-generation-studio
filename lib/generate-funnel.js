// lib/generate-funnel.js — Generate the full funnel copy (sales page content) from a
// short course description, using Gemini (Interactions API) in JSON mode.
//
// Produces every text field referenced by the master funnel template in ONE call:
//   hero, problem/solution, audience, instructor bio, testimonials, "what's inside"
//   cards, 8 modules, pricing block, satisfaction, FAQ, footer.
//
// Output shape is locked — every field maps 1:1 to a Custom Value in CC360. If the
// model returns the wrong shape we retry; after `maxAttempts` we surface the parse
// error so the caller can decide what to do.
//
import { generateJsonText } from './gemini.js';
import { retryAi, isTransient } from './retry.js';

export async function generateFunnelContent({
  apiKey,
  model = 'gemini-3.7-flash',
  courseTitle,
  courseDescription,
  instructorName,
  coursePrice,                  // raw string like "$997 one time"
  brandPrimary,                 // optional, only used to color-hint copy if needed
  instructions = '',
}) {
  if (!courseTitle) throw new Error('courseTitle is required');
  if (!courseDescription || courseDescription.trim().length < 20) {
    throw new Error('courseDescription must be at least 20 characters');
  }
  if (!instructorName) throw new Error('instructorName is required');

  const prompt = buildFunnelPrompt({
    courseTitle, courseDescription, instructorName, coursePrice, instructions,
  });

  return await retryAi(async () => {
    const raw = await generateJsonText({ apiKey, model, prompt, maxOutputTokens: 8000 });
    const parsed = safeParseJson(raw);
    validateFunnelContent(parsed);
    return parsed;
  }, {
    label: 'Funnel content generation',
    maxAttempts: 4,
    shouldRetry: (err) => {
      if (isTransient(err)) return true;
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('json parse') || msg.includes('parse failed')) return true;
      if (msg.includes('missing required') || msg.includes('wrong length')) return true;
      return false;
    },
  });
}

// ---------------------------------------------------------------------
// Prompt — gives the model the exact JSON schema it must return
// ---------------------------------------------------------------------
function buildFunnelPrompt({ courseTitle, courseDescription, instructorName, coursePrice, instructions }) {
  return `You are writing the complete sales-page copy for an online course funnel. The output must be a single JSON object with the EXACT structure below — no extra fields, no missing fields, no markdown, no commentary.

The output will be used to populate a pre-built funnel template via merge tags. Every string you generate goes directly into a public-facing landing page.

== INPUTS ==
Course Title: ${courseTitle}
Course Description (the seed): ${courseDescription}
Instructor First Name: ${instructorName}
Course Price (as it should appear): ${coursePrice || '$497 one time'}
Special Instructions: ${instructions || '(none)'}

== REQUIRED JSON STRUCTURE ==

{
  "hero": {
    "eyebrow": "Short uppercase tagline, 6-12 words, the elevator pitch of the course — ends with no period",
    "headline": "Big hero headline, 8-16 words. Should evoke a transformation. Use em-dashes for emphasis if natural.",
    "subheadline": "1 short sentence (12-20 words) clarifying what they'll learn or get.",
    "cta": "Get instant access here!",
    "star_text": "Short social-proof line under the rating, like 'Thousands of happy customers worldwide' — 5-9 words"
  },
  "problem": {
    "eyebrow": "UPPERCASE — names the problem and hints at the solution, 10-16 words",
    "headline": "Short emotional question, 3-6 words — usually 'Does this sound like you?' or close variant",
    "pains": [
      "5 short pain points the target audience faces.",
      "Each 6-12 words, ends with a period.",
      "Concrete and visceral — speak the customer's frustration.",
      "Pain #4",
      "Pain #5"
    ],
    "solutions": [
      "5 solution statements that DIRECTLY MIRROR the 5 pains in order.",
      "Each 6-14 words.",
      "Phrased as future-state benefits the course delivers.",
      "Solution #4 (mirrors Pain #4)",
      "Solution #5 (mirrors Pain #5)"
    ]
  },
  "audience": {
    "headline": "1 sentence (15-30 words) describing exactly who this course is for.",
    "tags": [
      "8 short audience labels (2-4 words each), each in Title Case.",
      "Examples: 'Burned-Out Professionals', 'Parents Wanting Healthier Families'",
      "Make them specific and aspirational",
      "Tag 4", "Tag 5", "Tag 6", "Tag 7", "Tag 8"
    ]
  },
  "instructor": {
    "bio_1": "Opening paragraph (2-3 sentences) introducing the instructor's expertise and years of experience. Write in first person ('I'm ...'). Use the name '${instructorName}'.",
    "bio_2": "Paragraph 2 (2-3 sentences) about their personal journey or why they created this course. First person.",
    "bio_3": "Paragraph 3 (1-2 sentences) about what graduates/students typically achieve.",
    "credentials": [
      "6 short credential bullets — each 8-15 words.",
      "Each one starts with a power verb or a number.",
      "Examples: 'Performed over 8,000 live consultations worldwide.'",
      "Credential 4", "Credential 5", "Credential 6"
    ]
  },
  "testimonials": [
    {
      "quote": "Realistic testimonial in first person (2-4 sentences). Wrap the quote in straight ASCII double quotes inside the string is fine, or just leave it unquoted — but the OUTER JSON string delimiter must remain a proper double quote.",
      "name": "Plausible full first name + last initial (e.g. 'Marilyn C.') — diverse names across the 3 testimonials"
    },
    { "quote": "Second testimonial — focuses on a different benefit", "name": "John D." },
    { "quote": "Third testimonial — focuses on a third benefit", "name": "Roberta J." }
  ],
  "inside_cards": [
    { "title": "Short card title (3-7 words)", "desc": "1-sentence description (10-18 words)" },
    { "title": "Card 2 title", "desc": "Card 2 desc" },
    { "title": "Card 3 title", "desc": "Card 3 desc" },
    { "title": "Card 4 title", "desc": "Card 4 desc" },
    { "title": "Card 5 title", "desc": "Card 5 desc" },
    { "title": "Card 6 title", "desc": "Card 6 desc" }
  ],
  "modules": [
    {
      "title": "Week 1 – [Topic] — short title with dash, 5-10 words. Use the en-dash character or just a hyphen.",
      "desc": "1-2 sentence description of what's taught in this module (15-30 words)"
    },
    { "title": "Week 2 – ...", "desc": "..." },
    { "title": "Week 3 – ...", "desc": "..." },
    { "title": "Week 4 – ...", "desc": "..." },
    { "title": "Week 5 – ...", "desc": "..." },
    { "title": "Bonus Module – ...", "desc": "..." },
    { "title": "Bonus Module – ...", "desc": "..." },
    { "title": "Bonus Module – ...", "desc": "..." }
  ],
  "pricing": {
    "title": "Pricing card headline — usually the course title with a benefit, 5-10 words",
    "desc": "Pricing card sub-description (2-3 sentences) recapping the transformation",
    "benefits": [
      "4 'what you get' bullets, each 8-16 words, starting with a benefit noun.",
      "Examples: 'Instant, lifetime access to 40+ bite-sized video lessons.'",
      "Benefit 3", "Benefit 4"
    ],
    "featured_quote": "1 punchy testimonial quote (2-3 sentences) used in the pricing block. Different from the 3 above.",
    "featured_name": "Plausible first + last initial"
  },
  "satisfaction": {
    "eyebrow": "Short uppercase phrase like 'STILL NOT SURE?'",
    "headline": "Reassurance headline, 2-4 words — usually 'Satisfaction guaranteed' or close",
    "body": "1-2 sentences (20-40 words) about the refund window and the team's confidence in the product."
  },
  "checkout": {
    "eyebrow": "Short uppercase phrase above the checkout headline — usually 'CHECKOUT FORM' or 'YOUR ORDER'",
    "headline": "Checkout page headline, 2-5 words — usually 'Complete your order' or close",
    "form_title": "The transformation H1 shown on the order form, 4-8 words, evoking who they'll BECOME after the course. Examples: 'Become the Fittest Version of Yourself', 'Reclaim Your Energy and Vitality'.",
    "form_subtitle": "1 sentence (10-20 words) recapping the value prop, like a brief tagline for what they're buying."
  },
  "confirmation": {
    "eyebrow": "Short uppercase phrase celebrating the purchase — usually 'SUCCESS! YOU\\u2019RE IN!' or 'YOU\\u2019RE ENROLLED!'",
    "headline": "Welcome headline 4-8 words celebrating the purchase. Should naturally include the course/program name. Do NOT use 'Welcome to' twice — pick ONE approach: either 'Welcome to [course name]!' OR a different verb structure like 'You're enrolled in [course name]!' or '[Course name] starts now!'. Never repeat words. Examples: 'Welcome to FitPro Academy!', 'You're enrolled in Learn Yoga in 7 Days!', 'The Clean Blood Protocol starts now!'",
    "next_steps_eyebrow": "Short uppercase phrase like 'HERE\\u2019S YOUR NEXT STEPS' or 'WHAT\\u2019S NEXT'",
    "next_steps_headline": "Action-oriented headline 2-5 words telling them what to do next. Examples: 'Check your email!', 'Access your portal'",
    "next_steps_body": "1-2 sentences (15-30 words) instructing them on what they should do or expect immediately after purchase, like login credentials being emailed."
  },
  "faq": [
    { "q": "FAQ question 1 (5-12 words) ending in a question mark", "a": "Honest 2-3 sentence answer addressing the concern" },
    { "q": "FAQ question 2", "a": "Answer 2" },
    { "q": "FAQ question 3", "a": "Answer 3" }
  ],
  "final_cta_headline": "Closing CTA headline, 3-7 words, often 'Enroll in the course now!' or a close variant",
  "course_trademark_name": "Course name styled with a trademark, like 'Clean Blood Protocol™' — derive from the course title"
}

== STRICT FORMATTING RULES ==

- Output must be a single JSON object. No surrounding text. No markdown fences.
- Use ONLY straight ASCII double quotes (") as JSON string delimiters.
- Inside string values, use straight apostrophes (') not curly quotes.
- Do NOT include unescaped double quotes inside string values.
- Do NOT include newlines inside string values.
- Do NOT add trailing commas.
- All arrays must have EXACTLY the number of items specified.
- Output must be parseable by strict JSON.parse().

== TONE & VOICE ==

- Punchy, confident, benefit-driven — like a top direct-response copywriter.
- Speak directly to the reader ("you", "your").
- Avoid hype words ("game-changing", "revolutionary"). Be specific instead.
- Match the tone implied by the course description and instructor positioning.
- Testimonials should feel real — varied lengths, different angles, specific outcomes.`;
}

// ---------------------------------------------------------------------
// Validation — schema enforcement
// ---------------------------------------------------------------------
function validateFunnelContent(c) {
  if (!c || typeof c !== 'object') fail('content is not an object');

  // Hero
  requireFields(c.hero, ['eyebrow', 'headline', 'subheadline', 'cta', 'star_text'], 'hero');

  // Problem
  requireFields(c.problem, ['eyebrow', 'headline', 'pains', 'solutions'], 'problem');
  requireArrayLen(c.problem.pains, 5, 'problem.pains');
  requireArrayLen(c.problem.solutions, 5, 'problem.solutions');

  // Audience
  requireFields(c.audience, ['headline', 'tags'], 'audience');
  requireArrayLen(c.audience.tags, 8, 'audience.tags');

  // Instructor
  requireFields(c.instructor, ['bio_1', 'bio_2', 'bio_3', 'credentials'], 'instructor');
  requireArrayLen(c.instructor.credentials, 6, 'instructor.credentials');

  // Testimonials
  requireArrayLen(c.testimonials, 3, 'testimonials');
  c.testimonials.forEach((t, i) => requireFields(t, ['quote', 'name'], `testimonials[${i}]`));

  // Inside cards
  requireArrayLen(c.inside_cards, 6, 'inside_cards');
  c.inside_cards.forEach((card, i) => requireFields(card, ['title', 'desc'], `inside_cards[${i}]`));

  // Modules
  requireArrayLen(c.modules, 8, 'modules');
  c.modules.forEach((m, i) => requireFields(m, ['title', 'desc'], `modules[${i}]`));

  // Pricing
  requireFields(c.pricing, ['title', 'desc', 'benefits', 'featured_quote', 'featured_name'], 'pricing');
  requireArrayLen(c.pricing.benefits, 4, 'pricing.benefits');

  // Satisfaction
  requireFields(c.satisfaction, ['eyebrow', 'headline', 'body'], 'satisfaction');

  // Checkout (Step 2 of the funnel)
  requireFields(c.checkout, ['eyebrow', 'headline', 'form_title', 'form_subtitle'], 'checkout');

  // Confirmation (Step 3 of the funnel)
  requireFields(c.confirmation, ['eyebrow', 'headline', 'next_steps_eyebrow', 'next_steps_headline', 'next_steps_body'], 'confirmation');

  // FAQ
  requireArrayLen(c.faq, 3, 'faq');
  c.faq.forEach((f, i) => requireFields(f, ['q', 'a'], `faq[${i}]`));

  // Misc
  if (typeof c.final_cta_headline !== 'string' || !c.final_cta_headline.trim()) fail('missing required final_cta_headline');
  if (typeof c.course_trademark_name !== 'string' || !c.course_trademark_name.trim()) fail('missing required course_trademark_name');
}

function requireFields(obj, fields, path) {
  if (!obj || typeof obj !== 'object') fail(`${path} is missing or not an object`);
  for (const f of fields) {
    const v = obj[f];
    if (Array.isArray(v)) { if (v.length === 0) fail(`missing required ${path}.${f} (empty array)`); continue; }
    if (typeof v !== 'string' || !v.trim()) fail(`missing required ${path}.${f}`);
  }
}
function requireArrayLen(arr, len, path) {
  if (!Array.isArray(arr)) fail(`${path} is not an array`);
  if (arr.length !== len) fail(`${path} has wrong length (got ${arr.length}, need ${len})`);
}
function fail(msg) { throw new Error(msg); }

// ---------------------------------------------------------------------
// JSON parsing — same defensive shape as generate.js
// ---------------------------------------------------------------------
function safeParseJson(raw) {
  let text = (raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(text); } catch (_) {}
  const cleaned = text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch (e) {
    throw new Error(`funnel JSON parse failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------
// Helper — map a funnel-content object to a flat { name -> value } map
// suitable for the Custom Values PUT loop in funnel-push.js.
//
// Image fields (`module_*_image_url`, `instructor_photo_url`,
// `pricing_laptop_image`) are deliberately NOT added here — those come from
// the image generation/upload step, merged in by the caller.
// ---------------------------------------------------------------------
export function flattenToCustomValueMap(content, { coursePrice, footerYear }) {
  const map = {};

  // Hero
  map.hero_eyebrow = content.hero.eyebrow;
  map.hero_headline = content.hero.headline;
  map.hero_subheadline = content.hero.subheadline;
  map.hero_cta = content.hero.cta;
  map.hero_star_text = content.hero.star_text;
  // NOTE: instructor email is NOT a custom value — the template wires {{location.email}}
  // (the sub-account's built-in business email) directly in the page builder.

  // Problem
  map.problem_eyebrow = content.problem.eyebrow;
  map.problem_headline = content.problem.headline;
  content.problem.pains.forEach((p, i) => { map[`problem_pain_${i + 1}`] = p; });
  content.problem.solutions.forEach((s, i) => { map[`problem_solution_${i + 1}`] = s; });

  // Audience
  map.audience_headline = content.audience.headline;
  content.audience.tags.forEach((t, i) => { map[`audience_tag_${i + 1}`] = t; });

  // Instructor
  map.instructor_bio_1 = content.instructor.bio_1;
  map.instructor_bio_2 = content.instructor.bio_2;
  map.instructor_bio_3 = content.instructor.bio_3;
  content.instructor.credentials.forEach((c, i) => { map[`instructor_credential_${i + 1}`] = c; });

  // Testimonials (quote + name only — photos are fixed defaults)
  content.testimonials.forEach((t, i) => {
    map[`testimonial_${i + 1}_quote`] = t.quote;
    map[`testimonial_${i + 1}_name`] = t.name;
  });

  // Inside cards
  content.inside_cards.forEach((c, i) => {
    map[`inside_card_${i + 1}_title`] = c.title;
    map[`inside_card_${i + 1}_desc`] = c.desc;
  });

  // Modules (titles + descs — image URLs added by caller after upload)
  content.modules.forEach((m, i) => {
    map[`module_${i + 1}_title`] = m.title;
    map[`module_${i + 1}_desc`] = m.desc;
  });

  // Pricing
  map.pricing_title = content.pricing.title;
  map.pricing_desc = content.pricing.desc;
  content.pricing.benefits.forEach((b, i) => { map[`pricing_benefit_${i + 1}`] = b; });
  if (coursePrice) map.pricing_price = coursePrice;
  map.pricing_featured_quote = content.pricing.featured_quote;
  map.pricing_featured_name = content.pricing.featured_name;

  // Satisfaction
  map.satisfaction_eyebrow = content.satisfaction.eyebrow;
  map.satisfaction_headline = content.satisfaction.headline;
  map.satisfaction_body = content.satisfaction.body;

  // Checkout page (Step 2 of the funnel)
  map.checkout_eyebrow = content.checkout.eyebrow;
  map.checkout_headline = content.checkout.headline;
  map.checkout_form_title = content.checkout.form_title;
  map.checkout_form_subtitle = content.checkout.form_subtitle;

  // Confirmation page (Step 3 of the funnel)
  map.confirmation_eyebrow = content.confirmation.eyebrow;
  map.confirmation_headline = content.confirmation.headline;
  map.confirmation_next_steps_eyebrow = content.confirmation.next_steps_eyebrow;
  map.confirmation_next_steps_headline = content.confirmation.next_steps_headline;
  map.confirmation_next_steps_body = content.confirmation.next_steps_body;

  // FAQ
  content.faq.forEach((f, i) => {
    map[`faq_q_${i + 1}`] = f.q;
    map[`faq_a_${i + 1}`] = f.a;
  });

  // Footer + final CTA
  map.final_cta_headline = content.final_cta_headline;
  map.course_trademark_name = content.course_trademark_name;
  map.footer_year = String(footerYear || new Date().getFullYear());

  return map;
}

// ---------------------------------------------------------------------
// Preview view-model adapters
//
// The interactive preview UI (public/funnel-visual-preview.html) expects
// a FLAT shape with top-level keys like `hero_headline`, `pains[]`,
// `confirm_eyebrow`, etc. — different from the NESTED shape the AI
// generator produces and that `flattenToCustomValueMap` consumes.
//
// We keep `draft.funnelContent` in the canonical nested shape (so the
// push pipeline keeps working unchanged) and convert at the API boundary:
//   • GET  /api/draft/:id  →  nestedToFlatPreview(content, input)
//   • PUT  /api/draft/:id  →  flatPreviewToNested(flat, draft.funnelContent)
//
// Fields the preview doesn't edit (e.g. testimonial names, static labels)
// are preserved on the way out by passing the existing nested object as
// the base in flatPreviewToNested.
// ---------------------------------------------------------------------
export function nestedToFlatPreview(content, input = {}) {
  if (!content || typeof content !== 'object') return null;
  const out = {};

  // Top-level inputs (not from the AI funnel content — from the draft form)
  if (input.courseTitle)      out.course_name      = input.courseTitle;
  if (input.instructorName)   out.instructor_name  = input.instructorName;
  if (input.coursePrice)      out.price            = input.coursePrice;
  out.year = String(new Date().getFullYear());

  // Hero
  if (content.hero) {
    out.hero_eyebrow     = content.hero.eyebrow;
    out.hero_headline    = content.hero.headline;
    out.hero_subheadline = content.hero.subheadline;
    out.hero_cta         = content.hero.cta;
    out.hero_star_text   = content.hero.star_text;
  }

  // Problem
  if (content.problem) {
    out.problem_eyebrow  = content.problem.eyebrow;
    out.problem_headline = content.problem.headline;
    out.pains            = Array.isArray(content.problem.pains)     ? content.problem.pains.slice()     : [];
    out.solutions        = Array.isArray(content.problem.solutions) ? content.problem.solutions.slice() : [];
  }

  // Audience
  if (content.audience) {
    out.audience_headline = content.audience.headline;
    out.audience_tags     = Array.isArray(content.audience.tags) ? content.audience.tags.slice() : [];
  }

  // Instructor
  if (content.instructor) {
    out.instructor_bio_1 = content.instructor.bio_1;
    out.instructor_bio_2 = content.instructor.bio_2;
    out.instructor_bio_3 = content.instructor.bio_3;
    out.instructor_credentials = Array.isArray(content.instructor.credentials)
      ? content.instructor.credentials.slice() : [];
  }

  // Testimonials — preview reads only `quote` (names are static template defaults)
  if (Array.isArray(content.testimonials)) {
    out.testimonials = content.testimonials.map(t => ({ quote: t?.quote || '' }));
  }

  // Inside cards — shape already compatible
  if (Array.isArray(content.inside_cards)) {
    out.inside_cards = content.inside_cards.map(c => ({
      title: c?.title || '', desc: c?.desc || '',
    }));
  }

  // Modules — shape already compatible
  if (Array.isArray(content.modules)) {
    out.modules = content.modules.map(m => ({
      title: m?.title || '', desc: m?.desc || '',
    }));
  }

  // Pricing
  if (content.pricing) {
    out.pricing_title    = content.pricing.title;
    out.pricing_desc     = content.pricing.desc;
    out.pricing_benefits = Array.isArray(content.pricing.benefits) ? content.pricing.benefits.slice() : [];
    out.featured_quote   = content.pricing.featured_quote;
    out.featured_name    = content.pricing.featured_name;
  }

  // Satisfaction
  if (content.satisfaction) {
    out.satisfaction_headline = content.satisfaction.headline;
    out.satisfaction_body     = content.satisfaction.body;
  }

  // FAQ — shape already compatible
  if (Array.isArray(content.faq)) {
    out.faq = content.faq.map(f => ({ q: f?.q || '', a: f?.a || '' }));
  }

  // Final CTA + trademark
  if (content.final_cta_headline)   out.final_cta_headline = content.final_cta_headline;
  if (content.course_trademark_name) out.trademark         = content.course_trademark_name;

  // Checkout — note the key renaming: generator's form_title/form_subtitle map to
  // the preview's checkout_subhead/checkout_desc
  if (content.checkout) {
    out.checkout_eyebrow  = content.checkout.eyebrow;
    out.checkout_headline = content.checkout.headline;
    out.checkout_subhead  = content.checkout.form_title;
    out.checkout_desc     = content.checkout.form_subtitle;
  }

  // Confirmation — note the key renaming: confirmation.* → confirm_*
  if (content.confirmation) {
    out.confirm_eyebrow       = content.confirmation.eyebrow;
    out.confirm_headline      = content.confirmation.headline;
    out.confirm_next_eyebrow  = content.confirmation.next_steps_eyebrow;
    out.confirm_next_headline = content.confirmation.next_steps_headline;
    out.confirm_next_body     = content.confirmation.next_steps_body;
  }

  return out;
}

export function flatPreviewToNested(flat, existing = {}) {
  if (!flat || typeof flat !== 'object') return existing;
  // Deep clone existing so we don't mutate the caller's object
  const out = existing ? JSON.parse(JSON.stringify(existing)) : {};

  // Hero
  out.hero = out.hero || {};
  if (flat.hero_eyebrow     != null) out.hero.eyebrow     = flat.hero_eyebrow;
  if (flat.hero_headline    != null) out.hero.headline    = flat.hero_headline;
  if (flat.hero_subheadline != null) out.hero.subheadline = flat.hero_subheadline;
  if (flat.hero_cta         != null) out.hero.cta         = flat.hero_cta;
  if (flat.hero_star_text   != null) out.hero.star_text   = flat.hero_star_text;

  // Problem
  out.problem = out.problem || {};
  if (flat.problem_eyebrow  != null) out.problem.eyebrow  = flat.problem_eyebrow;
  if (flat.problem_headline != null) out.problem.headline = flat.problem_headline;
  if (Array.isArray(flat.pains))     out.problem.pains     = flat.pains.slice();
  if (Array.isArray(flat.solutions)) out.problem.solutions = flat.solutions.slice();

  // Audience
  out.audience = out.audience || {};
  if (flat.audience_headline != null)   out.audience.headline = flat.audience_headline;
  if (Array.isArray(flat.audience_tags)) out.audience.tags    = flat.audience_tags.slice();

  // Instructor
  out.instructor = out.instructor || {};
  if (flat.instructor_bio_1 != null) out.instructor.bio_1 = flat.instructor_bio_1;
  if (flat.instructor_bio_2 != null) out.instructor.bio_2 = flat.instructor_bio_2;
  if (flat.instructor_bio_3 != null) out.instructor.bio_3 = flat.instructor_bio_3;
  if (Array.isArray(flat.instructor_credentials)) {
    out.instructor.credentials = flat.instructor_credentials.slice();
  }

  // Testimonials — preserve existing names; only overwrite quote
  if (Array.isArray(flat.testimonials)) {
    const existingT = Array.isArray(existing.testimonials) ? existing.testimonials : [];
    out.testimonials = flat.testimonials.map((t, i) => ({
      quote: t?.quote || '',
      name: existingT[i]?.name || '',
    }));
  }

  // Inside cards
  if (Array.isArray(flat.inside_cards)) {
    out.inside_cards = flat.inside_cards.map(c => ({
      title: c?.title || '', desc: c?.desc || '',
    }));
  }

  // Modules
  if (Array.isArray(flat.modules)) {
    out.modules = flat.modules.map(m => ({
      title: m?.title || '', desc: m?.desc || '',
    }));
  }

  // Pricing
  out.pricing = out.pricing || {};
  if (flat.pricing_title != null) out.pricing.title = flat.pricing_title;
  if (flat.pricing_desc  != null) out.pricing.desc  = flat.pricing_desc;
  if (Array.isArray(flat.pricing_benefits)) out.pricing.benefits = flat.pricing_benefits.slice();
  if (flat.featured_quote != null) out.pricing.featured_quote = flat.featured_quote;
  if (flat.featured_name  != null) out.pricing.featured_name  = flat.featured_name;

  // Satisfaction
  out.satisfaction = out.satisfaction || {};
  if (flat.satisfaction_headline != null) out.satisfaction.headline = flat.satisfaction_headline;
  if (flat.satisfaction_body     != null) out.satisfaction.body     = flat.satisfaction_body;

  // FAQ
  if (Array.isArray(flat.faq)) {
    out.faq = flat.faq.map(f => ({ q: f?.q || '', a: f?.a || '' }));
  }

  // Final CTA + trademark
  if (flat.final_cta_headline != null) out.final_cta_headline = flat.final_cta_headline;
  if (flat.trademark          != null) out.course_trademark_name = flat.trademark;

  // Checkout — reverse the key renaming
  out.checkout = out.checkout || {};
  if (flat.checkout_eyebrow  != null) out.checkout.eyebrow      = flat.checkout_eyebrow;
  if (flat.checkout_headline != null) out.checkout.headline     = flat.checkout_headline;
  if (flat.checkout_subhead  != null) out.checkout.form_title   = flat.checkout_subhead;
  if (flat.checkout_desc     != null) out.checkout.form_subtitle = flat.checkout_desc;

  // Confirmation — reverse the key renaming
  out.confirmation = out.confirmation || {};
  if (flat.confirm_eyebrow       != null) out.confirmation.eyebrow             = flat.confirm_eyebrow;
  if (flat.confirm_headline      != null) out.confirmation.headline            = flat.confirm_headline;
  if (flat.confirm_next_eyebrow  != null) out.confirmation.next_steps_eyebrow  = flat.confirm_next_eyebrow;
  if (flat.confirm_next_headline != null) out.confirmation.next_steps_headline = flat.confirm_next_headline;
  if (flat.confirm_next_body     != null) out.confirmation.next_steps_body     = flat.confirm_next_body;

  return out;
}