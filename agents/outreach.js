const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// ── DAILY SEND COUNTER ────────────────────────────────────────────────────
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const COUNTER_FILE = path.join(DATA_ROOT, 'leads', '.send-counter.json');
const RESEND_DAILY_LIMIT = 100;
const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;

function loadCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    const now = Date.now();
    if (data.startedAt && (now - data.startedAt) < RESET_INTERVAL_MS) return data;
    return { startedAt: now, resend: 0, brevo: 0, smtp: 0 };
  } catch {
    return { startedAt: Date.now(), resend: 0, brevo: 0, smtp: 0 };
  }
}

function saveCounter(counter) {
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter)); } catch {}
}

function getSendStats() {
  const counter = loadCounter();
  const elapsed = Date.now() - counter.startedAt;
  const remainingMs = Math.max(0, RESET_INTERVAL_MS - elapsed);
  const resetInHours = Math.floor(remainingMs / 3600000);
  const resetInMinutes = Math.floor((remainingMs % 3600000) / 60000);
  const BREVO_DAILY_LIMIT = 300;
  const resendCount = counter.resend || 0;
  const brevoCount = counter.brevo || 0;
  const totalSent = resendCount + brevoCount + (counter.smtp || 0);
  return {
    resend: resendCount, brevo: brevoCount, smtp: counter.smtp || 0, total: totalSent,
    resendLimit: RESEND_DAILY_LIMIT, brevoLimit: BREVO_DAILY_LIMIT,
    resendRemaining: Math.max(0, RESEND_DAILY_LIMIT - resendCount),
    brevoRemaining: Math.max(0, BREVO_DAILY_LIMIT - brevoCount),
    usingBrevo: resendCount >= RESEND_DAILY_LIMIT,
    resetsIn: `${resetInHours}h ${resetInMinutes}m`,
    resetsAtMs: counter.startedAt + RESET_INTERVAL_MS
  };
}

function incrementCounter(method) {
  const counter = loadCounter();
  counter[method] = (counter[method] || 0) + 1;
  saveCounter(counter);
  return counter;
}

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_key_here') throw new Error('Anthropic API key not set.');
  return new Anthropic({ apiKey: key });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cleanCopy(obj) {
  if (!obj) return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/\s*—\s*/g, ', ').replace(/,,/g, ',');
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      cleanCopy(obj[key]);
    }
  }
  return obj;
}

// ── VALID DEMO URL GUARD ──────────────────────────────────────────────────
function hasValidDemoUrl(url) {
  const s = url && String(url).trim();
  if (!s) return false;
  if (/localhost|127\.0\.0\.1|ngrok/i.test(s)) return false;
  if (s.includes('.pages.dev')) return true;
  if (/\/sites\/[^/?#]+/.test(s)) return true;
  try {
    const u = new URL(s);
    if (!u.hostname) return false;
    if (!u.pathname || u.pathname === '/') return false;
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

class NoDemoError extends Error {
  constructor(msg) { super(msg); this.code = 'NO_DEMO'; }
}

// ── INDUSTRY FOLLOW-UP EXAMPLES ───────────────────────────────────────────
function getFollowUpExamples(type) {
  const t = type.toLowerCase();
  const examples = {
    cafe: { short: 'a thank-you text 2 hours after their visit with a "come back this week for 10% off" nudge', scenarios: 'After a morning visit: "Thanks for stopping by today. Your usual cortado will be waiting." After a first visit: "Hope you loved it. Mention this text for a free pastry next time."' },
    coffee: { short: 'a thank-you text 2 hours after their visit with a "come back this week for 10% off" nudge', scenarios: 'After a morning visit: "Thanks for stopping by today. Your usual cortado will be waiting." After a first visit: "Hope you loved it. Mention this text for a free pastry next time."' },
    restaurant: { short: 'a follow-up the next day thanking them for dining in, plus a "book your next table" link', scenarios: 'After dinner: "Hope you enjoyed the meal last night. Your table is always here." Before holidays: "Valentine\'s reservations are filling up. Want us to save your usual spot?"' },
    'nail': { short: 'a rebooking nudge 2-3 weeks after their appointment, plus seasonal design drops', scenarios: 'At 2 weeks: "Your nails are probably ready for a refresh. Want to book your usual?" New season: "Fall colors just dropped. Book early for the new designs." Birthday: "Birthday nails on us, 20% off this month."' },
    'hair salon': { short: 'a rebooking reminder 4 weeks after their cut, plus birthday month specials', scenarios: 'After a cut: "Your hair looked amazing walking out. Book your next one before the rush?" At 6 weeks: "It\'s been a minute. Ready for a refresh?" Birthday month: automatic 15% off message.' },
    salon: { short: 'a rebooking reminder 4 weeks after their appointment, plus birthday month specials', scenarios: 'After an appointment: "You looked amazing walking out. Book your next one before the rush?" At 6 weeks: "It\'s been a minute. Ready for a refresh?" Birthday month: automatic 15% off message.' },
    hair: { short: 'a rebooking reminder 4 weeks after their cut, plus birthday month specials', scenarios: 'After a cut: "Your hair looked amazing walking out. Book your next one before the rush?" At 6 weeks: "It\'s been a minute. Ready for a refresh?" Birthday month: automatic 15% off message.' },
    auto: { short: 'an oil change reminder every 3 months, plus seasonal maintenance nudges', scenarios: 'At 3 months: "Your next oil change is coming up. Want to schedule before the weekend rush?" Before winter: "Cold weather is coming. Free tire pressure check if you swing by this week."' },
    yoga: { short: 'a check-in after their first class, plus weekly class schedule drops', scenarios: 'After first class: "How are you feeling after yesterday? Here\'s this week\'s schedule." If they miss a week: "We saved your spot in Thursday\'s flow class."' },
    fitness: { short: 'a check-in after their first session, plus milestone congratulations', scenarios: 'After signup: "How was your first workout? Need help with the equipment?" At 30 days: "One month in. You\'re building something real." If inactive: "Your gym misses you. Come back for a free smoothie."' },
    gym: { short: 'a check-in after their first workout, plus monthly progress nudges', scenarios: 'After first visit: "How was the workout? Any questions about the equipment?" At 2 weeks: "You\'re on a streak. Keep it going." If inactive 10 days: "Your routine is waiting. Free guest pass if you bring a friend."' },
    barbershop: { short: 'a "time for a fresh cut" reminder every 3-4 weeks', scenarios: 'At 3 weeks: "Looking a little shaggy? Your barber has Thursday open." After a cut: "Looking sharp. See you in a few weeks." Holiday: "Book your pre-holiday cut before slots fill up."' },
    barber: { short: 'a "time for a fresh cut" reminder every 3-4 weeks', scenarios: 'At 3 weeks: "Looking a little shaggy? Your barber has Thursday open." After a cut: "Looking sharp. See you in a few weeks." Holiday: "Book your pre-holiday cut before slots fill up."' },
    dental: { short: '6-month cleaning reminders, post-procedure check-ins, and braces adjustment recalls', scenarios: 'After a cleaning: "Great seeing you today. Your next cleaning is in 6 months, we\'ll remind you." After a filling: "How\'s the tooth feeling? Any sensitivity, just call us." Braces: "Your next adjustment is in 4 weeks. We\'ll text you a reminder."' },
    dentist: { short: '6-month cleaning reminders, post-procedure check-ins, and braces adjustment recalls', scenarios: 'After a cleaning: "Great seeing you today. Your next cleaning is in 6 months, we\'ll remind you." After a filling: "How\'s the tooth feeling? Any sensitivity, just call us." Braces: "Your next adjustment is in 4 weeks. We\'ll text you a reminder."' },
    vet: { short: 'vaccination reminders, annual checkup recalls, and post-visit check-ins', scenarios: 'After a visit: "How is [pet name] doing today? Any concerns, we\'re here." At 11 months: "Annual checkup time. [Pet name]\'s vaccines are due next month." Seasonal: "Flea and tick season is here. Need a refill on prevention?"' },
    bakery: { short: 'birthday cake reminders, holiday pre-order nudges, and "fresh batch" alerts', scenarios: 'Before their birthday: "Your birthday is coming up. Want us to save you a cake?" Before holidays: "Thanksgiving pie pre-orders are open. Last year we sold out." Weekly: "Fresh sourdough just came out of the oven."' },
    florist: { short: 'anniversary and holiday reminders so they never forget flowers again', scenarios: 'Before Valentine\'s: "Valentine\'s is next week. Want the same arrangement as last time?" Anniversary reminder: "Your anniversary is in 3 days. We have your usual ready." Mother\'s Day: "Don\'t forget Mom. Order by Friday for guaranteed delivery."' },
    flower: { short: 'anniversary and holiday reminders so they never forget flowers again', scenarios: 'Before Valentine\'s: "Valentine\'s is next week. Want the same arrangement as last time?" Anniversary reminder: "Your anniversary is in 3 days. We have your usual ready." Mother\'s Day: "Don\'t forget Mom. Order by Friday for guaranteed delivery."' },
    massage: { short: 'a rebooking reminder 3-4 weeks after their session, plus stress-relief tips', scenarios: 'After a session: "Hope you\'re feeling loose today. Drink plenty of water." At 4 weeks: "Your body is probably telling you it\'s time again. Same time next week?" Seasonal: "Holiday stress building up? We just opened extra evening slots."' },
    spa: { short: 'a rebooking reminder 3-4 weeks after their visit, plus seasonal treatment drops', scenarios: 'After a visit: "Hope you\'re still floating on that relaxation. Drink plenty of water today." At 4 weeks: "Time for another reset? We have openings this week." Birthday month: "Treat yourself, 20% off any treatment this month."' },
    roofer: { short: 'seasonal roof inspection reminders and post-storm check-in messages', scenarios: 'After a job: "How\'s everything looking up there? Any issues, we\'re a call away." Before storm season: "Big storms forecast this month. Want a free quick inspection?" Annual: "It\'s been a year since your last roof check. Time for a look?"' },
    contractor: { short: 'project follow-ups, seasonal maintenance reminders, and referral thank-yous', scenarios: 'After a project: "How\'s everything holding up? Let us know if anything needs adjusting." Seasonal: "Spring is the best time for that deck project we talked about." Referral: "Thanks for sending the Johnsons our way. Your next project gets priority scheduling."' },
    cleaning: { short: 'recurring service reminders, seasonal deep-clean nudges, and satisfaction check-ins', scenarios: 'After a clean: "Hope everything is sparkling. Anything we missed, just let us know." Monthly: "Your next cleaning is coming up. Same day and time work?" Seasonal: "Spring deep clean slots are filling up. Want us to book yours?"' },
    'marketing agency': { short: 'a check-in after campaign launch, plus quarterly strategy review reminders', scenarios: 'After onboarding: "Campaign is live. We\'ll send your first performance snapshot Friday." At 30 days: "Here\'s your month-one results. Let\'s talk next steps." Quarterly: "Q2 strategy session is on the books. Any new goals to add?"' },
    'digital agency': { short: 'a check-in after campaign launch, plus quarterly strategy review reminders', scenarios: 'After onboarding: "Campaign is live. We\'ll send your first performance snapshot Friday." At 30 days: "Here\'s your month-one results. Let\'s talk next steps." Quarterly: "Q2 strategy session is on the books. Any new goals to add?"' },
    'creative agency': { short: 'a check-in after project delivery, plus proactive campaign ideas each quarter', scenarios: 'After delivery: "Assets are live. Let us know how the team feels about the direction." At 30 days: "How are the new creatives performing? We have some fresh ideas." Quarterly: "New quarter, new concepts. Want to see what we\'ve been sketching?"' },
    'advertising agency': { short: 'a check-in after campaign launch, plus budget optimization nudges', scenarios: 'After launch: "Ads are running. First data comes in 48 hours." At 14 days: "Early results are in. Click-through is looking strong." Monthly: "Monthly ad review is ready. A few tweaks could stretch your budget further."' },
    'social media agency': { short: 'a content calendar reminder, plus engagement report check-ins', scenarios: 'After onboarding: "Your first week of content is scheduled. Preview it anytime." Weekly: "This week\'s posts are ready for your approval." Monthly: "Monthly engagement report is in. Your audience grew 12% this month."' },
    'seo agency': { short: 'a rankings update after the first 30 days, plus monthly performance snapshots', scenarios: 'After onboarding: "Baseline rankings captured. We\'ll send your first movement report in 30 days." At 30 days: "First rankings report is ready. A few quick wins already showing." Monthly: "Monthly SEO snapshot is in. Here\'s what moved and what\'s next."' },
    'pr agency': { short: 'a media coverage summary after each campaign, plus quarterly pitch strategy reviews', scenarios: 'After a placement: "Coverage is live. Here\'s the link and estimated reach." At 30 days: "Month-one media summary is ready. Here\'s what landed and what\'s in the pipeline." Quarterly: "Q2 pitch calendar is set. Any new stories or angles to add?"' },
    'web design agency': { short: 'a post-launch check-in, plus proactive performance and update reminders', scenarios: 'After launch: "Site is live. Here\'s the link, let us know what the client thinks." At 30 days: "How is the site performing? Any tweaks or requests from the client?" Quarterly: "Time for a site review. We can audit speed, copy, and conversion points."' },
    'video production agency': { short: 'a delivery confirmation, plus next-project ideation nudges', scenarios: 'After delivery: "Final files are in your Drive. Let us know if the client needs any revisions." At 30 days: "How did the video land? Any feedback we can carry into the next one?" Quarterly: "Q3 content calendar is coming up. Any video concepts worth pitching early?"' },
    'branding agency': { short: 'a post-delivery check-in, plus quarterly brand refresh ideas', scenarios: 'After delivery: "Brand assets are live in your shared folder. Let us know how the rollout goes." At 30 days: "How has the client been using the new brand? Any questions or tweaks?" Quarterly: "Good time for a brand audit. We can flag anything that\'s drifted off-guide."' },
    'content marketing agency': { short: 'a content performance summary after the first month, plus editorial calendar nudges', scenarios: 'After onboarding: "First batch of content is drafted and ready for your review." At 30 days: "Month-one content report is in. Here\'s what got traction and what to double down on." Monthly: "Next month\'s editorial calendar is ready. Any topics or campaigns to prioritize?"' },
    'email marketing agency': { short: 'a campaign performance summary after each send, plus list health check-ins', scenarios: 'After a send: "Campaign is out. Open rate and click data will be ready in 24 hours." At 7 days: "Here\'s the full performance breakdown. A few subject line tweaks could push opens higher." Monthly: "Monthly email report is in. List health looks good, here\'s what to test next."' },
    'media buying agency': { short: 'a spend and performance summary after campaign launch, plus monthly budget optimization nudges', scenarios: 'After launch: "Ads are running. First impression and click data comes in within 48 hours." At 14 days: "Two-week performance snapshot is ready. CPM is strong, a few placements to cut." Monthly: "Monthly ad review is in. Here\'s where the budget worked hardest and where to shift."' },
    agency: { short: 'a check-in after project kickoff, plus quarterly review reminders', scenarios: 'After kickoff: "Project is underway. We\'ll send a progress update Friday." At 30 days: "Month one is done. Here\'s where things stand." Quarterly: "Quarterly review time. Let\'s align on priorities for next quarter."' },
    default: { short: 'a thank-you message after their visit, plus periodic check-ins to keep them coming back', scenarios: 'After a visit: "Thanks for coming in. How was everything?" At 30 days: "It\'s been a month. We\'d love to see you again." Birthday: automatic birthday greeting with a special offer.' }
  };
  const sortedKeys = Object.keys(examples).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  const key = sortedKeys.find(k => t.includes(k)) || 'default';
  return examples[key];
}

// ── NO-WEBSITE OUTREACH PROMPT ────────────────────────────────────────────
function buildEmailPrompt(lead, previewUrl, type) {
  const hasRating = lead.rating && lead.rating !== 'N/A';
  const reviews = parseInt(lead.reviews) || 0;

  return `You generate cold outreach emails for ForgeAI, a digital growth agency. You will receive business data and must output a single plain-text email. Nothing else, no explanation, no preamble, just the subject line and email body.

CONTEXT:
- Business name: ${lead.name}
- Business type: ${type}
- Address: ${lead.address}
- Rating: ${hasRating ? lead.rating : 'no rating'}
- Number of reviews: ${reviews}
- Demo site URL: ${previewUrl}
- This business has NO website.

INSTRUCTIONS:
Goal: Get a reply by showing them a free website you already built for them, and making clear what it comes with.

- Subject: 2-5 words maximum. Must reference something specific and real about their business — their review count, rating, or a pain point tied to having no website. Should feel like an observation, not a sales pitch. Do not use "Quick question". Do not use "help". Use lowercase except for business name or proper nouns. Examples: "${reviews} reviews, no website", "your customers can't find you", "${lead.name} deserves a site", "${lead.rating} stars but invisible online". Make the owner feel like you specifically noticed something about their business.
- Paragraph 1: acknowledge their review count and rating in one sentence. Make it feel like you actually looked them up, not a template.
- Paragraph 2: one sentence on the problem. People search their name and find nothing — no way to book, check hours, or even confirm they exist.
- Paragraph 3: lead with the main offer — you already built them a free website. This is the hero. Keep it to 1-2 sentences max. Say it's already done and it's completely theirs to keep for free. Do NOT include the URL anywhere in the sentence. After this paragraph, on its own line with nothing else, output exactly this URL: ${previewUrl}
- Paragraph 4: an AI chatbot they can personally train to answer exactly the way they want, in their own voice, not a generic bot. It handles customer questions 24/7 and they get notified every time someone asks something. IMPORTANT: the sentence MUST include that they train it themselves to answer exactly how they want — do not drop this point.
- Paragraph 5: a completely separate automated follow-up system. The key point: the owner does not write messages, schedule anything, or decide when to reach out — the system does all of that automatically. It knows when to contact each customer and sends the text or email for them, no manual work needed. One clean sentence that makes this hands-off nature clear.
- Paragraph 6: make it clear everything is completely free. Say you'd love a quick call — not to sell anything, just to hear what's actually giving them headaches in their business, then show them how this helps. Keep it casual and genuine. Do NOT say "customize" or "tailor".
- Paragraph 7: end with one short soft question about the call. Examples: "Sound fair?", "Worth 5 minutes?", "Interested?". Must be under 8 words. Do NOT say "Want to see it?" or "Worth a quick look?" — the button handles that.
- Sign off: MUST end with Leif on its own line, then ForgeAIAgent on the next line. This is required, never skip it.
- Max length: 140 words

CRITICAL FORMATTING RULE: Every paragraph MUST be separated by a blank line. Paragraphs 4 and 5 are two distinct features — each on its own paragraph with a blank line between them. Do not combine any points. The sign-off (Leif and ForgeAIAgent) must always be present at the end.

RULES:
- Plain text only, no bullet points, bold, headers, or HTML
- No "I hope this email finds you well" or "I came across your business"
- No corporate words, no leverage, synergy, solutions, or optimize
- Do not mention ForgeAIAgent in the body, only in the sign-off
- Write like a real person emailing one specific business, not a mass campaign
- Every sentence must earn its place, cut anything that doesn't add value
- NEVER use em dashes (—) anywhere. Use commas or periods instead.

Return ONLY valid JSON with no extra text:
{"subject":"...","body":"..."}`;
}

// ── HAS-WEBSITE OUTREACH PROMPT ───────────────────────────────────────────
function buildWebsiteOutreachPrompt(lead, type) {
  const hasRating = lead.rating && lead.rating !== 'N/A';
  const reviews = parseInt(lead.reviews) || 0;
  const followUpExamples = getFollowUpExamples(type);
  const cityMatch = lead.address.match(/,\s*([^,]+),\s*[A-Z]{2}/);
  const city = cityMatch ? cityMatch[1].trim() : lead.address;

  return `You generate cold outreach emails for ForgeAI, a digital growth agency. You will receive business data and must output a single plain-text email. Nothing else, no explanation, no preamble, just the subject line and email body.

CONTEXT:
- Business name: ${lead.name}
- Business type: ${type}
- Address: ${lead.address}
- City: ${city}
- Rating: ${hasRating ? lead.rating : 'no rating'}
- Number of reviews: ${reviews}
- Website: ${lead.website || 'unknown'}
- This business ALREADY HAS a website.

INDUSTRY FOLLOW-UP CONTEXT for this ${type}:
${followUpExamples.scenarios}

INSTRUCTIONS:
Goal: Get a reply by naming a specific moment the owner recognizes and offering two clearly separate tools.

- Subject: 2-5 words maximum. Reference something specific about their business — their review count, rating, or a pain point tied to their industry. Should feel like an observation, not a pitch. Do not use "Quick question". Do not use "help". Use lowercase except for business name or proper nouns. Examples: "${reviews} reviews, no follow-up system", "after the visit is the gap", "${lead.rating} stars, losing regulars", "your ${type} customers aren't coming back".
- Paragraph 1: mention you were researching ${type} businesses in ${city} and noticed something specific and positive about their rating or review count. One natural opening sentence.
- Paragraph 2 (timeline hook): name the exact moment the problem shows up — the specific moment when customers decide whether to come back. Use the INDUSTRY FOLLOW-UP CONTEXT above to make this moment specific and real. Make the owner picture the situation. Most businesses go silent exactly at that moment.
- Paragraph 3: an AI chatbot added to their existing website. They personally train it to respond exactly the way they want, in their own voice. It handles customer questions 24/7 and they get notified every time someone asks something. One clean sentence. MUST include that they train it themselves to answer exactly how they want.
- Paragraph 4: a completely separate automated follow-up system. The key point: the owner does not write messages, schedule anything, or decide when to reach out — the system does all of that automatically. It knows when to contact each customer and sends the text or email for them, no manual work needed. One clean sentence that makes this hands-off nature clear. Do NOT include any URLs.
- Paragraph 5: make it clear you'll set both up completely free. Say you'd like a quick call — not to sell anything, but to hear what's actually causing friction in their business day to day. Keep it casual and genuine. Do NOT say "customize" or "tailor".
- Paragraph 6: end with one short interest-based question. Examples: "Is keeping more customers coming back something you're working on right now?", "Open to seeing how this works for a ${type}?", "Worth a quick look?". Must be under 12 words.
- Sign off: MUST end with Leif on its own line, then ForgeAIAgent on the next line. This is required, never skip it.
- Max length: 130 words

CRITICAL FORMATTING RULE: Every paragraph MUST be separated by a blank line. Paragraphs 3 and 4 are two distinct separate features — each on its own paragraph with a blank line between them. Do not combine them. The sign-off (Leif and ForgeAIAgent) must always be present at the end.

RULES:
- Plain text only, no bullet points, bold, headers, or HTML
- No "I hope this email finds you well" or "I came across your business"
- No corporate words, no leverage, synergy, solutions, or optimize
- Do not mention ForgeAIAgent in the body, only in the sign-off
- Write like a real person emailing one specific business, not a mass campaign
- Every sentence must earn its place, cut anything that doesn't add value
- Do not start with "Hi there" or any generic greeting. Start directly with the observation.
- Do not use the phrase "found your company" in the opening line.
- When ending a CTA question with "for a [business type]", use the owner-facing version: "for a pool cleaning company" not "for a pool cleaner".
- When referencing the business type in the opening line, never use the word "businesses" after the industry type. Use the natural word: "dental offices", "landscaping companies", "restaurants".
- NEVER use em dashes (—) anywhere. Use commas or periods instead.

Return ONLY valid JSON with no extra text:
{"subject":"...","body":"..."}`;
}

// ── AGENCY OUTREACH PROMPT ────────────────────────────────────────────────
function buildAgencyOutreachPrompt(lead, type) {
  const typeKey = type.toLowerCase().replace(/\s+/g, '_');

  const ctx = {
    marketing_agency: {
      pain: 'Running a marketing agency means managing client campaigns and finding new clients at the same time, with no real system behind the prospecting.',
      problem: 'Manual client outreach is slow, inconsistent, and hard to scale. Most marketing agencies either skip it or do it badly, and the pipeline suffers for it.',
      pitch: 'We run fully automated personalized outreach for your agency using AI. We find the leads, write the emails, send them, and follow up. You just forward the replies.',
    },
    digital_agency: {
      pain: 'Running a digital agency means delivering work for current clients while somehow finding the next one, with no consistent system behind the search.',
      problem: 'Manual prospecting takes time you do not have. Most digital agencies rely on referrals and have no reliable way to fill the pipeline when work slows down.',
      pitch: 'We handle the full prospecting and outreach pipeline for your agency using AI. We find potential clients, write personalized emails, send them, and follow up. You focus on delivery.',
    },
    creative_agency: {
      pain: 'Creative agencies are great at the work but business development, finding brands to pitch and following up consistently, almost never gets the attention it deserves.',
      problem: 'Manual brand outreach is easy to deprioritize when client work picks up. Most creative agencies miss deals simply because the follow-up never happened.',
      pitch: 'We run automated outreach to brands and businesses that fit your niche using AI. We find them, write the pitch, send it, and follow up. You handle the creative conversation.',
    },
    advertising_agency: {
      pain: 'Running an advertising agency means chasing new clients while managing active campaigns at the same time, with no real outreach system behind the new business effort.',
      problem: 'Finding businesses ready to invest in advertising is manual, slow, and inconsistent. Most ad agencies grow through referrals because cold outreach never gets systematized.',
      pitch: 'We scout businesses with no ad presence and run automated personalized outreach on your behalf using AI. We find them, write the pitch, send it, and follow up until they reply.',
    },
    social_media_agency: {
      pain: 'Running a social media agency means constantly looking for the next client while keeping up with content for the ones you already have, with no outreach system behind the search.',
      problem: 'Manual prospecting for social clients is time consuming and inconsistent. Most agencies rely on referrals because there is no automated way to reach businesses that need their help.',
      pitch: 'We find businesses with a weak or missing social presence and run personalized outreach campaigns on your behalf using AI. We scout, write, send, and follow up automatically.',
    },
    seo_agency: {
      pain: 'Running an SEO agency means identifying businesses losing search traffic and reaching out before a competitor does, with no automated system to do it consistently.',
      problem: 'Manually finding local businesses ranking poorly and sending personalized outreach does not scale. Most SEO agencies miss opportunities simply because the prospecting never gets systematized.',
      pitch: 'We scout local businesses with weak search presence and run automated personalized outreach for your agency using AI. We find them, write the pitch, send it, and follow up.',
    },
    pr_agency: {
      pain: 'Running a PR agency means constantly pitching new brands while managing active campaigns, with no outreach system behind the new business effort.',
      problem: 'Manual brand outreach is inconsistent and easy to deprioritize when current campaigns demand attention. Most PR agencies miss clients simply because the follow-up never happens at scale.',
      pitch: 'We find brands and businesses that need PR representation and run automated personalized outreach on your behalf using AI. We identify the targets, write the pitch, send it, and follow up.',
    },
    web_design_agency: {
      pain: 'Running a web design agency means finding businesses with outdated or missing websites and reaching out before a competitor does, with no system to do it at scale.',
      problem: 'Manually searching for businesses that need a new site and sending personalized outreach one by one does not scale. Most web design agencies miss deals because prospecting never gets automated.',
      pitch: 'We scout businesses with no website or a clearly outdated one and run automated personalized outreach on your behalf using AI. We find them, write the pitch, send it, and follow up.',
    },
    video_production_agency: {
      pain: 'Running a video production agency means finding businesses that need video content before they go to a competitor, with no consistent outreach system to make it happen.',
      problem: 'Manually identifying businesses running no video content and sending personalized pitches does not scale. Most video agencies rely on referrals because cold prospecting never gets systematized.',
      pitch: 'We find businesses with no video presence and run automated personalized outreach on your behalf using AI. We scout the targets, write the pitch, send it, and follow up automatically.',
    },
    branding_agency: {
      pain: 'Running a branding agency means finding businesses that need a rebrand or are launching something new and reaching out at exactly the right time, with no system to do it consistently.',
      problem: 'Manual outreach to branding prospects is inconsistent and timing dependent. Most branding agencies miss opportunities because there is no automated way to stay in front of the right businesses.',
      pitch: 'We find new and growing businesses that need branding work and run automated personalized outreach on your behalf using AI. We identify the targets, write the pitch, send it, and follow up.',
    },
    content_marketing_agency: {
      pain: 'Running a content marketing agency means finding businesses with no content strategy and convincing them they need one, with no outreach system to do it at scale.',
      problem: 'Manually identifying businesses with weak content presence and sending personalized pitches does not scale. Most content agencies grow through referrals because systematic outreach never gets built.',
      pitch: 'We scout businesses with no content marketing presence and run automated personalized outreach for your agency using AI. We find them, write the pitch, send it, and follow up.',
    },
    email_marketing_agency: {
      pain: 'Running an email marketing agency means finding businesses leaving money on the table with no email strategy and reaching them before they figure it out themselves.',
      problem: 'Manually identifying businesses with no email list or campaigns and sending personalized outreach does not scale. Most email agencies rely on referrals because prospecting never gets systematized.',
      pitch: 'We find businesses with no email marketing presence and run automated personalized outreach on your behalf using AI. We scout them, write the pitch, send it, and follow up until they reply.',
    },
    media_buying_agency: {
      pain: 'Running a media buying agency means finding businesses leaving ad budget on the table and reaching out before a competitor does, with no system to prospect consistently.',
      problem: 'Manually identifying businesses with no paid ad presence and sending personalized pitches does not scale. Most media buying agencies grow through referrals because cold outreach never gets automated.',
      pitch: 'We find businesses spending nothing on paid media and run automated personalized outreach on your behalf using AI. We identify the targets, write the pitch, send it, and follow up automatically.',
    },
  }[typeKey] || {
    pain: 'Running a small agency means doing client work and finding new clients at the same time, with no real system behind the outreach.',
    problem: 'Manual prospecting is slow, inconsistent, and hard to scale. Most agencies either skip it or do it badly, and their pipeline suffers.',
    pitch: 'We run fully automated personalized outreach for your agency using AI. We find the leads, write the emails, send them, and follow up. You just forward the replies.',
  };

  return `You write cold outreach emails to small agency owners. Output only the subject and body, no explanation.

CONTEXT:
- Business name: ${lead.name}
- Business type: ${type}

BODY STRUCTURE — write these four paragraphs in order, each separated by a blank line:

Paragraph 1: "${ctx.pain}"

Paragraph 2: "${ctx.problem}"

Paragraph 3: "${ctx.pitch}"

Paragraph 4: "We just ran a test campaign, 100 personalized emails sent in under 10 minutes with zero manual work after setup."

After paragraph 4, add one short soft question on its own line. Make it specific to a ${type}. Never ask for a call. Never mention pricing.

Sign off: Leif on its own line, then ForgeAI on the next line. Nothing else after that.

SUBJECT LINE: 2-5 words, lowercase, specific to a ${type} and their biggest prospecting pain.

RULES:
- Plain text only. No bullet points, no bold, no headers, no HTML.
- No corporate words. No em dashes. No exclamation points.
- Max 100 words total in the body.
- Return ONLY valid JSON: {"subject":"...","body":"..."}`;
}

// ── EMAIL SENDING ─────────────────────────────────────────────────────────
async function callAnthropicWithTimeout(client, params, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const msg = await client.messages.create(params, { signal: controller.signal });
    return msg;
  } catch(e) {
    if (e.name === 'AbortError' || e.message?.includes('abort')) throw new Error('Anthropic API timed out after ' + Math.round(timeoutMs/1000) + 's. Try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function sendWithRetry(resend, emailOpts, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await resend.emails.send(emailOpts);
    if (!error) return data;
    if (error.statusCode === 429 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
      continue;
    }
    throw new Error(`Resend API error: ${error.message || JSON.stringify(error)}`);
  }
}

async function sendViaBrevo(emailOpts) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('Brevo API key not configured.');
  const fromMatch = emailOpts.from.match(/^(.+?)\s*<(.+?)>$/);
  const senderName = fromMatch ? fromMatch[1].trim() : 'Leif';
  const senderEmail = fromMatch ? fromMatch[2].trim() : emailOpts.from;
  const res = await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: senderName, email: senderEmail },
    replyTo: { email: emailOpts.reply_to || senderEmail },
    to: [{ email: emailOpts.to }],
    subject: emailOpts.subject,
    textContent: emailOpts.text,
    htmlContent: emailOpts.html,
    headers: emailOpts.headers || {},
  }, {
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return { id: res.data?.messageId || res.data?.messageIds?.[0], method: 'brevo' };
}

async function generateEmailCopy(lead, previewUrl, outreachType) {
  const client = getClient();
  const type = (lead.type || 'business').replace(/_/g, ' ');
  const prompt = outreachType === 'agency'
    ? buildAgencyOutreachPrompt(lead, type)
    : outreachType === 'has_website'
    ? buildWebsiteOutreachPrompt(lead, type)
    : buildEmailPrompt(lead, previewUrl, type);
  const msg = await callAnthropicWithTimeout(client, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });
  const result = parseJSON(msg.content[0].text);
  if (!result?.subject || !result?.body) throw new Error('Failed to generate email copy. Try again.');
  return cleanCopy(result);
}

async function generateEmailPreview(lead, previewUrl, outreachType) {
  return generateEmailCopy(lead, previewUrl, outreachType);
}

async function generateFreeSamples(lead) {
  const client = getClient();
  const type = (lead.type || 'business').replace(/_/g, ' ');
  const rating = lead.rating !== 'N/A' ? lead.rating + '/5' : '';
  const reviews = lead.reviews && lead.reviews !== 'N/A' ? lead.reviews + ' reviews' : '';
  const msg = await callAnthropicWithTimeout(client, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content:
`Generate 3 polished, professional AI samples for "${lead.name}", a ${type} at ${lead.address}. ${rating ? 'Rating: ' + rating : ''} ${reviews}.

IMPORTANT: NEVER use em dashes (—) anywhere. Use commas or periods instead. Exclamation marks are fine where they feel natural.

NICHE-SPECIFIC FOLLOW-UP CONTEXT for this ${type}:
${getFollowUpExamples(type).scenarios}

Return ONLY valid JSON:
{
  "instagram_post": "Polished ready-to-post Instagram caption. 3-4 sentences, professional and engaging, speaks to their ideal customer, ends with CTA and 5-7 relevant hashtags. Specific to their business type and location.",
  "review_response": "Warm professional response to a 5-star Google review. Thank [Customer Name], reference their experience warmly, invite them back. Personal and genuine, not templated. 2-3 sentences.",
  "followup_message": "A real example of an automated follow-up message specific to a ${type}. Use the niche context above for inspiration. Make it feel like a real text from the business, not a template. Professional but warm. Under 60 words."
}`
    }]
  });
  const result = parseJSON(msg.content[0].text);
  if (!result) throw new Error('Failed to generate samples. Claude returned invalid JSON.');
  return cleanCopy(result);
}

async function sendOutreach(lead, previewUrl, emailAddress, onProgress, subjectOverride, bodyOverride, trackingOpts, outreachType, isFollowUp) {
  const isHasWebsite = outreachType === 'has_website';
  const isAgency = outreachType === 'agency';

  if (!isHasWebsite && !isAgency && !hasValidDemoUrl(previewUrl)) {
    throw new NoDemoError(`No demo site built for ${lead.name}. Run the Builder first so the email has a real demo to link to.`);
  }

  const copy = (subjectOverride && bodyOverride)
    ? { subject: subjectOverride, body: bodyOverride }
    : await generateEmailCopy(lead, previewUrl, outreachType);

  const { RESEND_API_KEY, RESEND_FROM, BREVO_API_KEY, SMTP_HOST, SMTP_USER } = process.env;
  if (!RESEND_API_KEY && !BREVO_API_KEY && !SMTP_HOST) throw new Error('No email provider configured. Set Resend, Brevo, or SMTP in Settings.');

  const fromEmail = RESEND_FROM || SMTP_USER || 'leif@forgeaiagent.com';
  onProgress({ status: 'sending', message: `Sending to ${emailAddress}...` });

  // Build HTML — clean personal email style (no branding, no buttons)
  let bodyText = copy.body;
  const lines = bodyText.split('\n').filter(l => l.trim());
  let bodyHtml = '';

  for (const l of lines) {
    const trimmedLine = l.trim();

    // URL-only line — render as plain text link (no_website only, first-touch skips links)
    if (!isHasWebsite && !isAgency && trimmedLine.match(/^https?:\/\/\S+$/) && previewUrl && trimmedLine.includes(previewUrl.split('/')[2])) {
      bodyHtml += `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#111"><a href="${escapeHtml(previewUrl)}" style="color:#2563eb;text-decoration:underline">${escapeHtml(previewUrl)}</a></p>`;
      continue;
    }

    // Sign-off — plain text, like a real person
    if (/^(Leif|ForgeAI|ForgeAIAgent)$/i.test(trimmedLine)) {
      bodyHtml += `<p style="margin:0 0 4px;font-size:14px;line-height:1.7;color:#111">${escapeHtml(trimmedLine)}</p>`;
      continue;
    }

    // Default paragraph
    bodyHtml += `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#111">${escapeHtml(l)}</p>`;
  }

  // Follow-ups get links (recipient already got the intro); first-touch emails stay clean
  if (isFollowUp) {
    if (!isHasWebsite && !isAgency && previewUrl && !bodyHtml.includes(previewUrl)) {
      bodyHtml += `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#111">Here's the demo I put together: <a href="${escapeHtml(previewUrl)}" style="color:#2563eb;text-decoration:underline">${escapeHtml(previewUrl)}</a></p>`;
    }
    if ((isHasWebsite || isAgency) && !bodyHtml.includes('forgeaiagent.com')) {
      bodyHtml += `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#111"><a href="https://www.forgeaiagent.com/how-it-works" style="color:#2563eb;text-decoration:underline">See how it works</a></p>`;
    }
  }

  const pixelHtml = trackingOpts?.pixelHtml || '';
  const unsubscribeUrl = trackingOpts?.unsubscribeUrl || '';
  // Plain text unsubscribe line (no styled footer)
  const unsubscribeFooter = unsubscribeUrl
    ? `<p style="margin:24px 0 0;font-size:11px;color:#999">To stop receiving emails: <a href="${escapeHtml(unsubscribeUrl)}" style="color:#999;text-decoration:underline">unsubscribe</a></p>`
    : '';

  const emailPayload = {
    from: `Leif <${fromEmail}>`,
    to: emailAddress,
    reply_to: fromEmail,
    headers: {
      'List-Unsubscribe': unsubscribeUrl ? `<${unsubscribeUrl}>, <mailto:${fromEmail}?subject=unsubscribe>` : `<mailto:${fromEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    },
    subject: copy.subject,
    text: copy.body + (unsubscribeUrl ? `\n\nTo stop receiving emails: ${unsubscribeUrl}` : ''),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px">${bodyHtml}${pixelHtml}${unsubscribeFooter}</div>`
  };

  let data;
  let sendMethod;

  const currentStats = getSendStats();
  const resendAvailable = RESEND_API_KEY && RESEND_FROM && currentStats.resendRemaining > 0;
  const brevoAvailable = BREVO_API_KEY && currentStats.brevoRemaining > 0;

  if (resendAvailable) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY);
      data = await sendWithRetry(resend, emailPayload);
      sendMethod = 'resend';
    } catch(resendErr) {
      if (brevoAvailable) {
        try { data = await sendViaBrevo(emailPayload); sendMethod = 'brevo'; }
        catch(brevoErr) {
          const err = new Error(`Resend: ${resendErr.message}. Brevo: ${brevoErr.response?.data?.message || brevoErr.message}`);
          err.dailyLimitReached = true; throw err;
        }
      } else {
        const err = new Error(`Resend failed: ${resendErr.message}.`);
        err.dailyLimitReached = true; throw err;
      }
    }
  } else if (brevoAvailable) {
    try { data = await sendViaBrevo(emailPayload); sendMethod = 'brevo'; }
    catch(brevoErr) {
      const err = new Error(`Brevo failed: ${brevoErr.response?.data?.message || brevoErr.message}`);
      err.dailyLimitReached = true; throw err;
    }
  } else {
    const reasons = [];
    if (!RESEND_API_KEY) reasons.push('Resend not configured');
    else if (currentStats.resendRemaining <= 0) reasons.push(`Resend: ${currentStats.resend}/${currentStats.resendLimit} used`);
    if (!BREVO_API_KEY) reasons.push('Brevo not configured');
    else if (currentStats.brevoRemaining <= 0) reasons.push(`Brevo: ${currentStats.brevo}/${currentStats.brevoLimit} used`);
    const err = new Error(`No email provider available. ${reasons.join('. ')}. Resets in ${currentStats.resetsIn}`);
    err.dailyLimitReached = true; throw err;
  }

  incrementCounter(sendMethod);
  const stats = getSendStats();
  const methodLabel = sendMethod === 'brevo' ? 'Brevo' : 'Resend';
  onProgress({ status: 'sent', message: `Sent to ${emailAddress} via ${methodLabel} (${stats.total} today | Resend: ${stats.resendRemaining} left, Brevo: ${stats.brevoRemaining} left)` });
  return { subject: copy.subject, body: copy.body, sentTo: emailAddress, sentAt: new Date().toISOString(), resendId: data?.id, sendMethod, outreachType: outreachType || 'no_website' };
}

// ── FOLLOW-UP EMAIL GENERATION ────────────────────────────────────────────
async function generateFollowUpEmail(lead, step, previousSubject) {
  const client = getClient();
  const type = (lead.type || 'business').replace(/_/g, ' ');
  const hasWebsite = !!lead.website;
  const isAgency = /agency/i.test(lead.type || '');
  const scenarioDesc = isAgency
    ? 'SCENARIO: This is an agency owner. The first email pitched fully automated AI-powered cold email outreach for their agency: we find their leads, write personalized emails, send them, and follow up automatically. They just forward the replies. Do NOT mention chatbots, demo websites, or website building. Stay focused on the outreach automation pitch.'
    : hasWebsite
    ? 'SCENARIO A: Business has a website. First email offered a free AI chatbot on their existing site (they train it themselves, get notified on questions) plus a fully automated follow-up system that contacts customers without any manual work from the owner.'
    : 'SCENARIO B: Business has no website. A free demo site was already built for them with an AI chatbot included. The first email offered the demo site plus a separate automated follow-up system. A link to the demo is automatically added below the email body, so NEVER include any URLs.';

  const angles = [
    'This is follow-up #1. Acknowledge the previous email briefly, then introduce one real industry statistic that makes the core problem feel urgent. Tie it back to their specific situation.',
    'This is follow-up #2. Share a different angle or insight they haven\'t considered. A trend, a competitor behavior, or a customer pattern. Make the cost of inaction feel more concrete.',
    'This is follow-up #3 and final. Be direct and honest. Frame it as "I\'ll leave this with you." Make choosing to ignore it feel like a conscious decision. End with "Should I close this out?" or "Should I take this down?"'
  ];
  const angle = angles[Math.min(step - 1, angles.length - 1)];

  const prompt = `You are Leif from ForgeAIAgent, writing a follow-up cold email to a local US business owner who was already contacted but hasn't replied.

${scenarioDesc}

INPUT:
- business_name: ${lead.name}
- business_type: ${type}
- review_count: ${lead.reviews || 'unknown'}
- star_rating: ${lead.rating || 'unknown'}
- has_website: ${hasWebsite}
- first_outreach_subject: "${previousSubject}"

STEP: ${angle}

RULES:
- Write in plain text. No bullet points, no bold, no headers.
- Maximum 100 words in the body. Short paragraphs, one to two sentences each.
- Open by acknowledging the previous email briefly. Never say "I hope this finds you well" or anything corporate.
- Introduce one real, specific statistic that makes the core problem feel urgent and undeniable.
- Tie the stat back to their actual situation using the business details provided.
- Do not repeat the full pitch from the first email. Reference it once, move forward.
- NEVER include any URLs, links, or domain names in the email body.
- End with a single low-pressure question. Examples: "Still worth 5 minutes?", "Want to take a look?", "Worth a call this week?"
- Sign off: Leif on its own line, then ForgeAIAgent on the next line.
- NEVER use em dashes (—) anywhere. Use commas or periods instead.
- No exclamation points. No filler phrases. No semicolons.
- BANNED phrases: "just checking in", "following up", "wanted to reach out", "circling back", "touching base", "bumping this"

SUBJECT LINE RULES:
- 4 words or fewer
- Lowercase
- No clickbait

Return ONLY valid JSON: {"subject":"...","body":"..."}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await callAnthropicWithTimeout(client, {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      });
      const result = parseJSON(msg.content[0]?.text || '');
      if (result?.subject && result?.body) return cleanCopy(result);
      console.log(`[FollowUp] Attempt ${attempt}/3 bad JSON for ${lead.name}`);
    } catch(e) {
      console.log(`[FollowUp] Attempt ${attempt}/3 error for ${lead.name}: ${e.message}`);
      if (attempt === 3) throw e;
    }
  }
  throw new Error('Failed to generate follow-up after 3 attempts.');
}

// ── DM SCRIPT GENERATION ──────────────────────────────────────────────────
async function generateDMScript(lead, platform) {
  const client = getClient();
  const type = (lead.type || 'business').replace(/_/g, ' ');
  const platformName = platform === 'facebook' ? 'Facebook Messenger' : 'Instagram DM';
  const msg = await callAnthropicWithTimeout(client, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content:
`Generate 3 different ${platformName} scripts from Leif (Forge AI) to the owner of "${lead.name}", a ${type} at ${lead.address}.
Rating: ${lead.rating !== 'N/A' ? lead.rating + '/5 with ' + lead.reviews + ' reviews' : 'N/A'}.

Each script should be:
- Very casual and conversational (DM style, not email style)
- Under 60 words each
- Reference something specific about their business
- Mention that Leif built them a free demo website
- End with a soft call to action (link to demo or quick call)
- Sound like a real person, not a marketer
- Different angle for each (compliment, value-first, curiosity)

Return ONLY valid JSON:
{"scripts": [
  {"label": "Approach name", "text": "The DM script..."},
  {"label": "Approach name", "text": "The DM script..."},
  {"label": "Approach name", "text": "The DM script..."}
]}`
    }]
  });
  const result = parseJSON(msg.content[0].text);
  if (!result?.scripts) throw new Error('Failed to generate DM scripts.');
  return result.scripts;
}

// ── A/B SUBJECT LINE GENERATION ───────────────────────────────────────────
async function generateABSubjects(lead, previewUrl) {
  const client = getClient();
  const type = (lead.type || 'business').replace(/_/g, ' ');
  const msg = await callAnthropicWithTimeout(client, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content:
`Generate 2 very different email subject line variations for a cold outreach email from Leif (Forge AI) to "${lead.name}", a ${type}.

Variation A: More direct/specific - reference something about their business
Variation B: More curiosity-driven - create intrigue

Rules: Under 9 words each, no exclamation marks, sound like a real person, not a marketer.

Return ONLY valid JSON: {"subjectA":"...","subjectB":"..."}`
    }]
  });
  const result = parseJSON(msg.content[0].text);
  if (!result?.subjectA || !result?.subjectB) throw new Error('Failed to generate A/B subjects.');
  return result;
}

module.exports = { sendOutreach, generateEmailPreview, generateFreeSamples, generateFollowUpEmail, generateDMScript, generateABSubjects, getSendStats, hasValidDemoUrl, NoDemoError };
