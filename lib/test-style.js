import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STYLE_BLOCK = `
Visual style: Semi-realistic 3D animated illustration in the aesthetic of a modern animated film still or premium SaaS marketing illustration (think Pixar, modern Apple keynote graphics, or the 3D illustration style used by Stripe and Notion).

Render quality requirements:
- Stylized 3D characters with friendly, slightly exaggerated proportions (larger expressive eyes, simplified features) — NOT flat 2D cartoon, NOT photorealistic humans.
- Soft realistic lighting with a clear key light, ambient fill, and gentle rim light. Visible (but soft) cast shadows beneath subjects.
- Subtle material textures — matte skin, soft fabric folds, smooth plastic/metal highlights where appropriate.
- Ambient occlusion in corners and contact points for depth.
- Subtle depth-of-field — main subject sharply rendered, background slightly softened.
- Smooth, polished surfaces — no rough sketch lines, no harsh outlines.
- Warm, inviting color palette. Vibrant but not oversaturated. Premium feel.`;

const prompt = `A premium hero cover image for an educational online course called "Email Marketing Mastery". It teaches small business owners how to grow their list and write emails that sell.

Compose a scene featuring 3D-rendered stylized characters and/or thematic 3D objects that clearly represent email marketing. Clear focal point, balanced, welcoming, energetic. Use #6366f1 as the dominant brand color. Background: clean studio soft gradient with subtle depth.
${STYLE_BLOCK}

CRITICAL RULES:
- No text, no words, no letters anywhere.
- No UI mockups or fake screens.
- 3:2 landscape composition.`;

console.log('Generating test image...');
const result = await openai.images.generate({
  model: 'gpt-image-1-mini',
  prompt,
  size: '1536x1024',
  quality: 'medium',
  n: 1,
});

fs.writeFileSync('test-style.png', Buffer.from(result.data[0].b64_json, 'base64'));
console.log('✅ Saved to test-style.png — open and review.');