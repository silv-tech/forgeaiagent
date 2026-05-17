#!/usr/bin/env node
// One-shot test outreach sender. Uses the SAME renderOutreachHtml helper
// as the live outreach agent, so what you see here is exactly what real
// prospects will receive.
// Usage: node scripts/send-test-outreach.js <to-email> [has|no|both]
const path = require('path');
const fs = require('fs');

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const envPath = fs.existsSync(path.join(DATA_ROOT, 'leads', '.env'))
  ? path.join(DATA_ROOT, 'leads', '.env')
  : path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });

const { renderOutreachHtml } = require('../agents/email-template');

const TO = process.argv[2];
const WHICH = (process.argv[3] || 'both').toLowerCase();
if (!TO) { console.error('Usage: node scripts/send-test-outreach.js <to-email> [has|no|both]'); process.exit(1); }

const { RESEND_API_KEY, RESEND_FROM } = process.env;
if (!RESEND_API_KEY || !RESEND_FROM) {
  console.error('Missing RESEND_API_KEY or RESEND_FROM in env.');
  process.exit(1);
}

const { Resend } = require('resend');
const resend = new Resend(RESEND_API_KEY);

// Sample demo URL. In real sends this is the lead's cfpages.dev demo.
const DEMO_URL = 'https://demo-magic-flower-shop.pages.dev';

const TEMPLATES = {
  has: {
    subjectTag: 'HAS WEBSITE',
    subject: 'Had an idea for your site',
    testBanner: 'This is what an email to a business that already has a website looks like.',
    cta: false,
    body: [
      'Hey,',
      '',
      "I took a look at your current website and put together notes on a few things I'd change, faster load, cleaner layout, a more modern look, and a couple of features I'd add on top (a chatbot that can handle after-hours questions, a smoother way for visitors to get in touch).",
      '',
      "I'm Leif, I run Forge AI. We help local businesses turn sites that feel dated into ones that actually convert the traffic they already get, and I'd like to do that for you for free. You'd keep your domain, your content, and everything you already have, we'd just make the whole thing better.",
      '',
      "Happy to walk you through the notes on the call so you can see exactly what I'd change.",
    ].join('\n'),
    checklist: [
      'A redesign of your current site, faster, cleaner, and modern, with added features like a chatbot and improved contact flow',
      'A ready-to-post Instagram caption for your business',
      'A professional Google review response template',
      'A customer follow-up message template',
      'A full online presence audit'
    ]
  },
  no: {
    subjectTag: 'NO WEBSITE',
    subject: 'Built you a website',
    testBanner: 'This is what an email to a business that does not have a website yet looks like.',
    cta: true,
    body: [
      'Hey,',
      '',
      "I noticed you don't have a website yet, which honestly surprised me given the reviews you already have. So I went ahead and built one for you.",
      '',
      "I'm Leif, I run Forge AI. We build websites for local businesses using AI, which is why I could put this together for you for free before we'd even spoken.",
      '',
      "The demo below has your basic info, services, and a chatbot that can answer customer questions any time of day. It's a starting point, the real site gets built around your brand, your photos, and the way you actually want to show up online.",
    ].join('\n'),
    checklist: [
      'Your live demo website, already built',
      'A ready-to-post Instagram caption for your business',
      'A professional Google review response template',
      'A customer follow-up message template',
      'A full online presence audit'
    ]
  }
};

async function sendOne(key) {
  const t = TEMPLATES[key];
  const html = renderOutreachHtml({
    bodyText: t.body,
    ctaUrl: t.cta ? DEMO_URL : null,
    ctaLabel: 'View Your Demo Site',
    checklist: t.checklist,
    premiumAddOn: {
      title: 'One more thing worth mentioning',
      body: "We also set up automated follow-up systems for local businesses, text and email sequences that bring past customers back at the right moments, seasonal check-ins, touch-ups, referral nudges. For a business like yours with strong reviews and repeat-work potential, it's where we see the biggest long-term ROI for owners. Happy to walk you through how it works on the call if you're curious."
    },
    closingLine: 'All I ask in return is a 5-minute call so I can walk you through it. No pitch, no pressure.',
    testBanner: t.testBanner
  });

  const textBody = t.cta ? (t.body + '\n\nView the demo: ' + DEMO_URL) : t.body;

  const result = await resend.emails.send({
    from: `Leif | Forge AI <${RESEND_FROM}>`,
    to: TO,
    replyTo: RESEND_FROM,
    subject: `[TEST - ${t.subjectTag}] ${t.subject}`,
    text: textBody,
    html
  });
  console.log(`[${key}] id=${result?.data?.id || 'unknown'} error=${result?.error ? JSON.stringify(result.error) : 'none'}`);
}

(async () => {
  try {
    const which = WHICH === 'has' ? ['has']
                 : WHICH === 'no' ? ['no']
                 : ['has', 'no'];
    for (const key of which) {
      await sendOne(key);
      if (which.length > 1) await new Promise(r => setTimeout(r, 800));
    }
  } catch (e) {
    console.error('send failed:', e.message);
    process.exit(1);
  }
})();
