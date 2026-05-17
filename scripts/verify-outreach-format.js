#!/usr/bin/env node
// Regression guard for the outreach email template. Renders both the
// has-website and no-website variants, then asserts invariants. If
// anyone edits the template and breaks the agreed format, this script
// exits non-zero and tells you exactly what broke.
//
// Run: node scripts/verify-outreach-format.js
// Exit codes: 0 = all pass, 1 = one or more assertions failed.

const { renderOutreachHtml } = require('../agents/email-template');

const DEMO_URL = 'https://demo-business-example.pages.dev';

const PREMIUM_CALLOUT = {
  title: 'One more thing worth mentioning',
  body: "We also set up automated follow-up systems for local businesses, text and email sequences that bring past customers back at the right moments, seasonal check-ins, touch-ups, referral nudges. For a business like yours with strong reviews and repeat-work potential, it's where we see the biggest long-term ROI for owners. Happy to walk you through how it works on the call if you're curious."
};

const HAS_WEBSITE = renderOutreachHtml({
  bodyText: [
    'Hey,',
    '',
    "I took a look at your current website and put together notes on a few things I'd change.",
    '',
    "I'm Leif, I run Forge AI. We help local businesses turn sites that feel dated into ones that convert.",
    '',
    "Happy to walk you through the notes on the call."
  ].join('\n'),
  ctaUrl: null,
  checklist: [
    'A redesign of your current site, faster, cleaner, and modern, with added features like a chatbot and improved contact flow',
    'A ready-to-post Instagram caption for your business',
    'A professional Google review response template',
    'A customer follow-up message template',
    'A full online presence audit'
  ],
  premiumAddOn: PREMIUM_CALLOUT,
  closingLine: 'All I ask in return is a 5-minute call so I can walk you through it. No pitch, no pressure.'
});

const NO_WEBSITE = renderOutreachHtml({
  bodyText: [
    'Hey,',
    '',
    "I noticed you don't have a website yet. So I went ahead and built one for you.",
    '',
    "I'm Leif, I run Forge AI. We build websites for local businesses using AI."
  ].join('\n'),
  ctaUrl: DEMO_URL,
  ctaLabel: 'View Your Demo Site',
  checklist: [
    'Your live demo website, already built',
    'A ready-to-post Instagram caption for your business',
    'A professional Google review response template',
    'A customer follow-up message template',
    'A full online presence audit'
  ],
  premiumAddOn: PREMIUM_CALLOUT,
  closingLine: 'All I ask in return is a 5-minute call so I can walk you through it. No pitch, no pressure.'
});

const failures = [];
function check(label, cond, detail) {
  if (cond) { process.stdout.write(`  PASS  ${label}\n`); }
  else { failures.push({ label, detail }); process.stdout.write(`  FAIL  ${label}${detail ? ' — ' + detail : ''}\n`); }
}

console.log('\n== HAS WEBSITE variant ==');
check('No CTA button href to any demo URL',
  !/<a[^>]+href="https?:\/\/[^"]+\.pages\.dev/i.test(HAS_WEBSITE),
  'found a pages.dev link, button must be removed for has_website');
check('No "View Your Demo Site" label',
  !/View Your Demo Site/.test(HAS_WEBSITE),
  'button label still present');
check('No "built you a website" language',
  !/built you a website|built one for you/i.test(HAS_WEBSITE));
check('Has redesign language',
  /redesign|cleaner|faster/i.test(HAS_WEBSITE));
check('Checklist item 1 is redesign, not live demo',
  /redesign of your current site/i.test(HAS_WEBSITE) && !/live demo website/i.test(HAS_WEBSITE));
check('Premium add-on callout present',
  HAS_WEBSITE.includes('One more thing worth mentioning'));
check('No "PAID" badge or pill',
  !/\b(PAID|Optional add-on)\b/i.test(HAS_WEBSITE));
check('No money-signaling words',
  !/\b(paid service|upfront|package|tier|monthly fee|pricing)\b/i.test(HAS_WEBSITE));

console.log('\n== NO WEBSITE variant ==');
check('CTA button present with demo URL',
  new RegExp(`<a[^>]+href="${DEMO_URL}"`).test(NO_WEBSITE));
check('"View Your Demo Site" label present',
  /View Your Demo Site/.test(NO_WEBSITE));
check('Checklist item 1 is live demo website',
  /Your live demo website, already built/.test(NO_WEBSITE));
check('Premium add-on callout present',
  NO_WEBSITE.includes('One more thing worth mentioning'));
check('No "PAID" badge or pill',
  !/\b(PAID|Optional add-on)\b/i.test(NO_WEBSITE));

console.log('\n== Invariants on both variants ==');
for (const [name, html] of [['has_website', HAS_WEBSITE], ['no_website', NO_WEBSITE]]) {
  check(`${name}: Forge AI branding in header`,
    html.includes('Forge <span style="color:#2563eb">AI</span>'));
  check(`${name}: no WebForge/WEBFORGE anywhere`,
    !/WebForge|WEBFORGE/i.test(html));
  check(`${name}: signature says "Founder, Forge AI"`,
    html.includes('Founder, Forge AI'));
  check(`${name}: footer links to forgeaiagent.com`,
    /forgeaiagent\.com/.test(html));
  check(`${name}: no raw URLs inside body paragraphs`,
    !/<p[^>]*>[^<]*https?:\/\/[^<]*<\/p>/i.test(html),
    'body paragraph contains a raw URL, should be in CTA button only');
  check(`${name}: tagline "Websites, Chatbots, Follow-ups" present`,
    /Websites\s*&middot;\s*Chatbots\s*&middot;\s*Follow-ups/.test(html));
}

console.log('');
if (failures.length) {
  console.error(`FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log(`PASSED: all ${['has_website','no_website'].length === 2 ? '' : ''}invariants hold. Format is locked.`);
