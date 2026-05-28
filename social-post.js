// social-post.js
// Drop this file into your existing Railway backend
// Run manually: node social-post.js
// Or call the /generate-and-post endpoint

import fetch from 'node-fetch';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';

// ── Config ─────────────────────────────────────────────────────
const PAGE_TOKEN   = process.env.META_PAGE_ACCESS_TOKEN;
const PAGE_ID      = process.env.META_PAGE_ID;
const IG_USER_ID   = process.env.META_IG_USER_ID;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const CLOUDINARY_URL = process.env.CLOUDINARY_URL;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

cloudinary.config({ cloudinary_url: CLOUDINARY_URL });

// ── Brand Config ───────────────────────────────────────────────
// Edit this to match whichever brand you're posting for
const BRAND = {
  name: 'ShopDesk AI',
  voice: `Direct, honest, no hype. We speak like a knowledgeable friend 
    helping a small business owner. Short sentences. No corporate buzzwords. 
    We've tested this on real businesses and we're real people building this.`,
  audience: 'Small service business owners — HVAC, plumbers, med spas, auto tint, epoxy flooring',
  visualStyle: `Clean, modern, dark background with blue accents. 
    Professional but approachable. No stock photo vibes.`,
  hashtags: [
    '#ShopDeskAI', '#ServiceBusiness', '#NeverMissALead',
    '#SmallBusiness', '#AITools', '#LeadGeneration',
    '#HoustonBusiness', '#BusinessGrowth'
  ],
  contentPillars: [
    'pain_point',      // missed calls, lost leads
    'case_study',      // Jordy / Pure Vision Tints results
    'how_it_works',    // feature explanation
    'social_proof',    // testimonial
    'industry_insight' // tip for service business owners
  ]
};

// ── Step 1: Pick Today's Content Category ─────────────────────
function selectCategory(pillars) {
  const idx = Math.floor(Math.random() * pillars.length);
  return pillars[idx];
}

// ── Step 2: Generate Image Prompt ─────────────────────────────
async function generateImagePrompt(category) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are a creative director for ${BRAND.name}.
Visual style: ${BRAND.visualStyle}
Target audience: ${BRAND.audience}

Generate a DALL-E 3 image prompt for a social media post.
The image should feel professional, modern, and relevant to service businesses.
No text in the image. No people's faces. Focus on concepts, environments, or abstract visuals.
Keep the prompt under 200 characters.
Respond with just the prompt, nothing else.`
      },
      {
        role: 'user',
        content: `Content category: ${category}. Generate an image prompt.`
      }
    ]
  });
  return response.choices[0].message.content.trim();
}

// ── Step 3: Generate Image with DALL-E 3 ──────────────────────
async function generateImage(prompt) {
  console.log('🎨 Generating image...');
  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: `${prompt}. Style: ${BRAND.visualStyle}`,
    n: 1,
    size: '1024x1024',
    quality: 'hd'
  });
  return response.data[0].url;
}

// ── Step 4: Upload to Cloudinary ──────────────────────────────
async function uploadImage(tempUrl, label) {
  console.log('☁️  Uploading to Cloudinary...');
  const result = await cloudinary.uploader.upload(tempUrl, {
    folder: 'shopdesk-social',
    public_id: `post_${label}_${Date.now()}`,
    overwrite: false
  });
  return result.secure_url;
}

// ── Step 5: Generate Caption ──────────────────────────────────
async function generateCaption(category, imagePrompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are a social media copywriter for ${BRAND.name}.

Brand voice: ${BRAND.voice}
Target audience: ${BRAND.audience}

CAPTION RULES:
- First line must stop the scroll — bold statement or question, no emoji on line 1
- 3-5 sentences max
- 1 clear CTA at the end
- Sound human, never like AI wrote it
- Never use: "game-changer", "leverage", "synergy", "unlock", "revolutionize"
- Use occasional line breaks for readability
- End with a question or direct CTA to drive engagement

Respond with JSON only, no markdown:
{
  "caption": "full caption without hashtags",
  "cta": "the CTA line only",
  "firstLine": "just the first line for preview"
}`
      },
      {
        role: 'user',
        content: `Write a caption for a ${category} post. The image shows: ${imagePrompt}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  return JSON.parse(response.choices[0].message.content);
}

// ── Step 6: Post to Instagram ─────────────────────────────────
async function postToInstagram(imageUrl, fullCaption) {
  console.log('📸 Posting to Instagram...');

  // Step 6a: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption: fullCaption,
      access_token: PAGE_TOKEN
    })
  });

  const container = await containerRes.json();

  if (container.error) {
    throw new Error(`IG container error: ${container.error.message}`);
  }

  console.log('⏳ Waiting for container to be ready...');
  await waitForContainer(container.id);

  // Step 6b: Publish container
  const publishRes = await fetch(
    `https://graph.facebook.com/v19.0/${IG_USER_ID}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: container.id,
      access_token: PAGE_TOKEN
    })
  });

  const published = await publishRes.json();

  if (published.error) {
    throw new Error(`IG publish error: ${published.error.message}`);
  }

  return published.id;
}

async function waitForContainer(containerId, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${PAGE_TOKEN}`
    );
    const data = await res.json();
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error('Container failed');
    await sleep(2000);
  }
  throw new Error('Container timed out');
}

// ── Step 7: Post to Facebook ───────────────────────────────────
async function postToFacebook(imageUrl, fullCaption) {
  console.log('📘 Posting to Facebook...');

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${PAGE_ID}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: imageUrl,
      caption: fullCaption,
      access_token: PAGE_TOKEN
    })
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(`FB post error: ${data.error.message}`);
  }

  return data.id;
}

// ── Main Pipeline ──────────────────────────────────────────────
export async function runSocialPost(options = {}) {
  const {
    brandOverride = null,    // pass a different brand config if needed
    autoPost = true,         // set false to just generate and return content
    platforms = ['instagram', 'facebook']
  } = options;

  const brand = brandOverride || BRAND;

  try {
    console.log('\n🚀 Starting social post pipeline...\n');

    // 1. Pick category
    const category = selectCategory(brand.contentPillars);
    console.log(`📋 Category: ${category}`);

    // 2. Generate image prompt
    const imagePrompt = await generateImagePrompt(category);
    console.log(`🖼  Image prompt: ${imagePrompt}`);

    // 3. Generate image
    const tempUrl = await generateImage(imagePrompt);

    // 4. Upload to Cloudinary
    const permanentUrl = await uploadImage(tempUrl, category);
    console.log(`✅ Image uploaded: ${permanentUrl}`);

    // 5. Generate caption
    const { caption, cta } = await generateCaption(category, imagePrompt);
    const hashtags = brand.hashtags.slice(0, 8).join(' ');
    const fullCaption = `${caption}\n\n${cta}\n\n${hashtags}`;
    console.log(`✅ Caption generated`);
    console.log(`\n--- CAPTION PREVIEW ---\n${fullCaption}\n-----------------------\n`);

    // 6. Post or return for approval
    if (!autoPost) {
      console.log('✋ Auto-post disabled — returning content for review');
      return { imageUrl: permanentUrl, caption: fullCaption, category, imagePrompt };
    }

    const results = {};

    if (platforms.includes('instagram')) {
      results.igPostId = await postToInstagram(permanentUrl, fullCaption);
      console.log(`✅ Instagram posted: ${results.igPostId}`);
    }

    if (platforms.includes('facebook')) {
      results.fbPostId = await postToFacebook(permanentUrl, fullCaption);
      console.log(`✅ Facebook posted: ${results.fbPostId}`);
    }

    console.log('\n🎉 Pipeline complete!\n');
    return { success: true, ...results, imageUrl: permanentUrl };

  } catch (err) {
    console.error('❌ Pipeline failed:', err.message);
    throw err;
  }
}

// ── Utility ────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Run directly with: node social-post.js ────────────────────
if (process.argv[1].includes('social-post')) {
  runSocialPost({ autoPost: true })
    .then(result => {
      console.log('Result:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}