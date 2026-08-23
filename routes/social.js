import express from "express";
import cron from "node-cron";
import { runSocialPost, postToInstagram, postToFacebook } from "../social-post.js";

const router = express.Router();

// INSTAGRAM AND FACEBOOK POSTING AI

// ── Daily Auto-Post at 9am Houston time ───────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Daily social post cron fired');
  try {
    await runSocialPost({ autoPost: true });
  } catch (err) {
    console.error('Cron post failed:', err.message);
  }
}, {
  timezone: 'America/Chicago'
});

// ── Manual Trigger Endpoints ──────────────────────────────────

// POST /social/post - generate and post immediately
router.post('/social/post', async (req, res) => {
  try {
    const result = await runSocialPost({ autoPost: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /social/preview - generate only, don't post yet
// Returns the image and caption for your approval
router.post('/social/preview', async (req, res) => {
  try {
    const result = await runSocialPost({ autoPost: false });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /social/approve - post pre-generated content
// Call this after /preview to actually publish
router.post('/social/approve', async (req, res) => {
  const { imageUrl, caption } = req.body;
  if (!imageUrl || !caption) {
    return res.status(400).json({ error: 'imageUrl and caption required' });
  }
  try {
    const igPostId = await postToInstagram(imageUrl, caption);
    const fbPostId = await postToFacebook(imageUrl, caption);
    res.json({ success: true, igPostId, fbPostId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
