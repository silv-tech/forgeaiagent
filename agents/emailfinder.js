const axios = require('axios');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer');
// Social finder no longer needed, we use slug guessing + Puppeteer directly
const HUNTER = 'https://api.hunter.io/v2';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Shared browser instance (reused across calls)
let browserInstance = null;
let browserLaunching = null;
let igLoggedIn = false;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  // If another call is already launching, wait for it
  if (browserLaunching) return browserLaunching;
  // Close old disconnected browser if it exists
  if (browserInstance) { try { await browserInstance.close(); } catch {} }
  browserLaunching = puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    timeout: 20000
  });
  try {
    browserInstance = await browserLaunching;
    igLoggedIn = false;
    return browserInstance;
  } finally {
    browserLaunching = null;
  }
}

// Cleanup on process exit
process.on('SIGTERM', () => { if (browserInstance) browserInstance.close().catch(()=>{}); });
process.on('SIGINT', () => { if (browserInstance) browserInstance.close().catch(()=>{}); });

// Email extraction from text/HTML
function extractEmails(text) {
  const matches = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  const blacklist = ['facebook.com','fb.com','sentry.io','example.com','wixpress.com','googleapis.com',
    'w3.org','schema.org','fbcdn.net','instagram.com','yelp.com','google.com','twitter.com',
    'pinterest.com','youtube.com','linkedin.com','tiktok.com','meta.com',
    'noreply.com','notifications.com','no-reply.com','mailinator.com','tempmail.com',
    'guerrillamail.com','sharklasers.com','grr.la','apple.com','microsoft.com',
    'squarespace.com','wix.com','godaddy.com','wordpress.com','shopify.com'];
  return [...new Set(matches)].filter(e => {
    const domain = e.split('@')[1].toLowerCase();
    return !blacklist.some(b => domain.includes(b)) && e.length < 60;
  });
}

// Fetch a URL and return raw HTML (for websites, no JS needed)
function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const timer = setTimeout(() => reject(new Error('Timeout')), 10000);
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return fetchPage(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 500000) { res.destroy(); clearTimeout(timer); resolve(data); } });
      res.on('end', () => { clearTimeout(timer); resolve(data); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Generate Facebook slug guesses from business name
function generateSlugs(name, location) {
  // Clean name: remove emojis, parenthetical text, special chars
  let clean = name
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and');

  // Extract city abbreviation from location (e.g., "Los Angeles USA" -> "la")
  const cityAbbrevs = {
    'los angeles': 'la', 'new york': 'ny', 'san francisco': 'sf', 'san diego': 'sd',
    'las vegas': 'lv', 'washington': 'dc', 'chicago': 'chi', 'philadelphia': 'philly',
    'houston': 'htx', 'dallas': 'dfw', 'miami': 'mia', 'atlanta': 'atl',
    'denver': 'den', 'seattle': 'sea', 'boston': 'bos', 'phoenix': 'phx',
    'portland': 'pdx', 'austin': 'atx', 'nashville': 'nash',
  };
  const loc = (location || '').toLowerCase();
  let cityShort = '';
  for (const [city, abbr] of Object.entries(cityAbbrevs)) {
    if (loc.includes(city)) { cityShort = abbr; break; }
  }

  const words = clean.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const joined = words.join('');
  const dotted = words.join('.');
  const slugs = new Set();

  // Core variations
  slugs.add(joined);                           // marugamemonzo
  if (words.length > 1) slugs.add(dotted);     // marugame.monzo
  if (words.length > 1) slugs.add(words[0]);   // marugame (first word only)

  // With city suffix
  if (cityShort) {
    slugs.add(joined + cityShort);             // marugamemonzola
    slugs.add(joined + '.' + cityShort);       // marugamemonzo.la
    if (words.length > 1) slugs.add(words[0] + cityShort); // marugamela
  }

  // "the" prefix removal
  if (words[0] === 'the' && words.length > 1) {
    const noThe = words.slice(1).join('');
    slugs.add(noThe);
    if (cityShort) slugs.add(noThe + cityShort);
  }

  // "official" suffix
  slugs.add(joined + 'official');

  return [...slugs].slice(0, 8);
}

// Step 1: Find Facebook page via slug guessing + scrape for email in one pass (no login needed)
async function findEmailFromFacebook(lead, onProgress) {
  // If we already have a FB URL, go straight to scraping
  let knownUrl = lead.socials?.facebook?.url || null;

  if (!knownUrl) {
    const slugs = generateSlugs(lead.name, lead.location);
    if (!slugs.length) {
      onProgress && onProgress({ status:'not_found', message:`No Facebook page found for ${lead.name}` });
      return null;
    }

    onProgress && onProgress({ status:'searching', message:`📘 Trying ${slugs.length} Facebook URL guesses for ${lead.name}...` });
    const browser = await getBrowser();

    for (const slug of slugs) {
      let page;
      try {
        page = await browser.newPage();
        await page.setUserAgent(UA);
        const fbUrl = 'https://www.facebook.com/' + slug;
        await page.goto(fbUrl + '/about', { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        const text = await page.evaluate(() => document.body.innerText);

        const isReal = !text.includes("This page isn't available") &&
                       !text.includes('Page Not Found') &&
                       !text.includes("this content isn't available") &&
                       !text.includes('Sorry, this page') &&
                       text.length > 200;

        const emails = extractEmails(text);

        if (isReal || emails.length) {
          // Save the FB URL to the lead
          if (!lead.socials) lead.socials = {};
          if (!lead.socials.facebook) lead.socials.facebook = { url: fbUrl, source: 'slug_guess' };
          onProgress && onProgress({ status:'found', message:`📘 Found Facebook page: ${fbUrl}` });

          // We already have the about page text, check for email right here
          if (emails.length) {
            await page.close();
            onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${emails[0]}` });
            return { email: emails[0], confidence: 80, source: 'facebook' };
          }

          // No email on about page, try main page
          onProgress && onProgress({ status:'searching', message:`📘 Checking main FB page...` });
          await page.goto(fbUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          const mainText = await page.evaluate(() => document.body.innerText);
          const mainEmails = extractEmails(mainText);
          await page.close();

          if (mainEmails.length) {
            onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${mainEmails[0]}` });
            return { email: mainEmails[0], confidence: 80, source: 'facebook' };
          }

          onProgress && onProgress({ status:'not_found', message:`No email on Facebook page` });
          return null;
        }
        await page.close();
      } catch(e) {
        if (page) await page.close().catch(() => {});
      }
    }
    onProgress && onProgress({ status:'not_found', message:`No Facebook page found for ${lead.name}` });
    return null;
  }

  // Scrape known FB URL
  onProgress && onProgress({ status:'searching', message:`📘 Scraping Facebook: ${knownUrl}` });
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    const aboutUrl = knownUrl.replace(/\/$/, '') + '/about';
    await page.goto(aboutUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));
    const text = await page.evaluate(() => document.body.innerText);
    let emails = extractEmails(text);

    if (!emails.length) {
      onProgress && onProgress({ status:'searching', message:`📘 Checking main FB page...` });
      await page.goto(knownUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));
      const mainText = await page.evaluate(() => document.body.innerText);
      emails = extractEmails(mainText);
    }
    await page.close();

    if (emails.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${emails[0]}` });
      return { email: emails[0], confidence: 80, source: 'facebook' };
    }
    onProgress && onProgress({ status:'not_found', message:`No email on Facebook page` });
  } catch(e) {
    if (page) await page.close().catch(() => {});
    onProgress && onProgress({ status:'error', message:`⚠ Facebook scrape failed: ${e.message}` });
  }
  return null;
}

// Log into Instagram once, reuse session across scrapes
async function ensureIgLogin(browser, onProgress) {
  // Verify browser is still connected before trusting cached login
  if (igLoggedIn && browser.connected) return true;
  if (igLoggedIn && !browser.connected) {
    igLoggedIn = false; // Browser was disconnected, need to re-login
  }
  const email = process.env.FB_EMAIL;
  const pass = process.env.FB_PASSWORD;
  if (!email || !pass) return false;

  onProgress && onProgress({ status:'searching', message:`📸 Logging into Instagram...` });
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));

    // Instagram uses "username" not "email" for the login field
    const userField = await page.waitForSelector('input[name="username"], input[name="email"]', { timeout: 10000 });
    await userField.type(email, { delay: 50 });
    await page.type('input[name="password"], input[name="pass"]', pass, { delay: 50 });
    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"]') || document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    const url = page.url();
    if (url.includes('login') || url.includes('challenge') || url.includes('checkpoint')) {
      onProgress && onProgress({ status:'error', message:`⚠ Instagram login blocked, check account for security prompts` });
      await page.close();
      return false;
    }

    // Dismiss "Save Login Info" or "Turn on Notifications" popups
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const notNow = btns.find(b => (b.textContent || '').toLowerCase().includes('not now'));
      if (notNow) notNow.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const notNow = btns.find(b => (b.textContent || '').toLowerCase().includes('not now'));
      if (notNow) notNow.click();
    });

    igLoggedIn = true;
    onProgress && onProgress({ status:'found', message:`✅ Instagram login successful` });
    await page.close();
    return true;
  } catch(e) {
    if (page) await page.close().catch(() => {});
    onProgress && onProgress({ status:'error', message:`⚠ Instagram login failed: ${e.message}` });
    return false;
  }
}

// Step 2: Find Instagram page via slug guessing + scrape for email in one pass (needs IG login)
async function findEmailFromInstagram(lead, onProgress) {
  const browser = await getBrowser();
  const loggedIn = await ensureIgLogin(browser, onProgress);
  if (!loggedIn) {
    onProgress && onProgress({ status:'error', message:`⚠ Skipping Instagram, login failed` });
    return null;
  }

  // If we already have an IG URL, go straight to scraping
  let knownUrl = lead.socials?.instagram?.url || null;

  if (!knownUrl) {
    const slugs = generateSlugs(lead.name, lead.location);
    if (!slugs.length) {
      onProgress && onProgress({ status:'not_found', message:`No Instagram page found for ${lead.name}` });
      return null;
    }

    onProgress && onProgress({ status:'searching', message:`📸 Trying ${slugs.length} Instagram URL guesses...` });

    for (const slug of slugs) {
      let page;
      try {
        page = await browser.newPage();
        await page.setUserAgent(UA);
        const igUrl = 'https://www.instagram.com/' + slug + '/';
        await page.goto(igUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));

        const data = await page.evaluate(() => {
          const text = document.body.innerText;
          const exists = !text.includes("this page isn't available") &&
                         !text.includes("Sorry, this page") &&
                         !text.includes("Page Not Found") &&
                         document.querySelectorAll('header').length > 0;
          const mailtos = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.href.replace('mailto:', '').split('?')[0]);
          return { text, exists, mailtos };
        });
        await page.close();

        if (data.exists) {
          if (!lead.socials) lead.socials = {};
          if (!lead.socials.instagram) lead.socials.instagram = { url: igUrl, source: 'slug_guess' };
          onProgress && onProgress({ status:'found', message:`📸 Found Instagram: ${igUrl}` });

          // Extract email from the page we already loaded
          if (data.mailtos.length) {
            onProgress && onProgress({ status:'found', message:`✅ Found on Instagram (email button): ${data.mailtos[0]}` });
            return { email: data.mailtos[0], confidence: 90, source: 'instagram' };
          }
          const emails = extractEmails(data.text);
          if (emails.length) {
            onProgress && onProgress({ status:'found', message:`✅ Found on Instagram bio: ${emails[0]}` });
            return { email: emails[0], confidence: 75, source: 'instagram' };
          }

          onProgress && onProgress({ status:'not_found', message:`No email on Instagram` });
          return null;
        }
      } catch(e) {
        if (page) await page.close().catch(() => {});
      }
    }
    onProgress && onProgress({ status:'not_found', message:`No Instagram page found for ${lead.name}` });
    return null;
  }

  // Scrape known IG URL
  onProgress && onProgress({ status:'searching', message:`📸 Scraping Instagram: ${knownUrl}` });
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(knownUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const mailtos = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.href.replace('mailto:', '').split('?')[0]);
      return { text, mailtos };
    });
    await page.close();

    if (data.mailtos.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found on Instagram (email button): ${data.mailtos[0]}` });
      return { email: data.mailtos[0], confidence: 90, source: 'instagram' };
    }
    const emails = extractEmails(data.text);
    if (emails.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found on Instagram bio: ${emails[0]}` });
      return { email: emails[0], confidence: 75, source: 'instagram' };
    }
    onProgress && onProgress({ status:'not_found', message:`No email on Instagram` });
  } catch(e) {
    if (page) await page.close().catch(() => {});
    onProgress && onProgress({ status:'error', message:`⚠ Instagram scrape failed: ${e.message}` });
  }
  return null;
}

// Step 3: Scrape business website (plain HTTP, no browser needed)
async function findEmailFromWebsite(lead, onProgress) {
  const website = lead.socials?.website || lead.website || null;
  if (!website) return null;

  onProgress && onProgress({ status:'searching', message:`🌐 Scanning website: ${website}` });
  try {
    const html = await fetchPage(website);
    let emails = extractEmails(html);

    // Also try /contact page
    if (!emails.length) {
      try {
        const contactUrl = new URL('/contact', website).href;
        onProgress && onProgress({ status:'searching', message:`🌐 Checking ${contactUrl}` });
        const contactHtml = await fetchPage(contactUrl);
        emails = extractEmails(contactHtml);
      } catch {}
    }

    if (emails.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found on website: ${emails[0]}` });
      return { email: emails[0], confidence: 85, source: 'website' };
    }
    onProgress && onProgress({ status:'not_found', message:`No email on website` });
  } catch(e) {
    onProgress && onProgress({ status:'error', message:`⚠ Could not fetch website: ${e.message}` });
  }
  return null;
}

// Hunter.io lookup (separate, only called on demand)
async function hunterSearch(lead, onProgress) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) {
    onProgress && onProgress({ status:'error', message:`❌ Hunter.io API key not set in Settings` });
    return null;
  }

  onProgress && onProgress({ status:'searching', message:`🔍 Searching Hunter.io for ${lead.name}...` });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(`${HUNTER}/email-finder`, {
        params: { company: lead.name, api_key: key },
        timeout: 8000
      });
      if (res.data.data?.email) {
        const { email, score } = res.data.data;
        onProgress && onProgress({ status:'found', message:`✅ Hunter.io: ${email} (${score}%)` });
        return { email, confidence: score, source: 'hunter' };
      }
      break;
    } catch(e) {
      if (e.response?.status === 429 && attempt === 0) {
        onProgress && onProgress({ status:'limit', message:`⚠ Hunter rate limit, waiting 5s...` });
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (e.response?.status === 401) {
        onProgress && onProgress({ status:'error', message:`❌ Hunter API key invalid` });
        break;
      }
      onProgress && onProgress({ status:'error', message:`⚠ Hunter failed: ${e.message}` });
      break;
    }
  }
  onProgress && onProgress({ status:'not_found', message:`❌ No email found via Hunter.io` });
  return null;
}

// Main findEmail pipeline: Facebook slug guess → Instagram slug guess → Website
async function findEmail(lead, onProgress) {
  onProgress && onProgress({ status:'searching', message:`🔎 Finding email for ${lead.name}...` });
  const sources = [];

  // Step 1: Find + scrape Facebook page (slug guessing → Puppeteer scrape, no login needed)
  try {
    const fb = await findEmailFromFacebook(lead, onProgress);
    if (fb) { markSearched(lead); return fb; }
    sources.push('Facebook: no email found');
  } catch(e) {
    sources.push(`Facebook: error (${e.message})`);
    onProgress && onProgress({ status:'error', message:`⚠ Facebook search failed: ${e.message}` });
  }

  // Step 2: Find + scrape Instagram page (slug guessing → Puppeteer scrape, needs IG login)
  try {
    const ig = await findEmailFromInstagram(lead, onProgress);
    if (ig) { markSearched(lead); return ig; }
    sources.push('Instagram: no email found');
  } catch(e) {
    sources.push(`Instagram: error (${e.message})`);
    onProgress && onProgress({ status:'error', message:`⚠ Instagram search failed: ${e.message}` });
  }

  // Step 3: Try website if available (usually not, since scout filters for no-website leads)
  try {
    const web = await findEmailFromWebsite(lead, onProgress);
    if (web) { markSearched(lead); return web; }
    sources.push('Website: no email found');
  } catch(e) {
    sources.push(`Website: error (${e.message})`);
    onProgress && onProgress({ status:'error', message:`⚠ Website search failed: ${e.message}` });
  }

  markSearched(lead);
  onProgress && onProgress({ status:'not_found', message:`❌ No email found for ${lead.name} (checked: ${sources.join('; ')})` });
  return null;
}

function markSearched(lead) {
  if (!lead.socials) lead.socials = {};
  lead.socials.searchedAt = new Date().toISOString();
}

async function checkCredits() {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get(`${HUNTER}/account`, { params: { api_key: key }, timeout: 5000 });
    const r = res.data.data?.requests;
    return { used: r?.searches?.used || 0, available: r?.searches?.available || 0 };
  } catch { return null; }
}

module.exports = { findEmail, hunterSearch, checkCredits };
