const axios = require('axios');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer');
// Social finder no longer needed, we use slug guessing + Puppeteer directly
const HUNTER = 'https://api.hunter.io/v2';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// SSRF protection: reject URLs pointing at internal/private networks
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '[::1]') return false;
    // Check for private/reserved IP ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 127) return false;                    // 127.x.x.x loopback
      if (a === 10) return false;                     // 10.x.x.x private
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16-31.x.x private
      if (a === 192 && b === 168) return false;       // 192.168.x.x private
      if (a === 169 && b === 254) return false;       // 169.254.x.x link-local
    }
    return true;
  } catch {
    return false;
  }
}

// Concurrency limiter for Puppeteer pages
const MAX_PAGES = 3;
let activePagesCount = 0;
async function acquirePage() {
  while (activePagesCount >= MAX_PAGES) await new Promise(r => setTimeout(r, 500));
  activePagesCount++;
  const browser = await getBrowser();
  return browser.newPage();
}
function releasePage(page) {
  activePagesCount--;
  if (page) page.close().catch(() => {});
}

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
    return !blacklist.some(b => domain === b || domain.endsWith('.' + b)) && e.length < 60;
  });
}

// Fetch a URL and return raw HTML (for websites, no JS needed)
function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const timer = setTimeout(() => reject(new Error('Timeout')), 10000);
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': UA } }, res => {
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

    for (const slug of slugs) {
      let page;
      try {
        page = await acquirePage();
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
            releasePage(page); page = null;
            onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${emails[0]}` });
            return { email: emails[0], confidence: 80, source: 'facebook' };
          }

          // No email on about page, try main page
          onProgress && onProgress({ status:'searching', message:`📘 Checking main FB page...` });
          await page.goto(fbUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          const mainText = await page.evaluate(() => document.body.innerText);
          const mainEmails = extractEmails(mainText);
          releasePage(page); page = null;

          if (mainEmails.length) {
            onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${mainEmails[0]}` });
            return { email: mainEmails[0], confidence: 80, source: 'facebook' };
          }

          onProgress && onProgress({ status:'not_found', message:`No email on Facebook page` });
          return null;
        }
        releasePage(page); page = null;
      } catch(e) {
        if (page) releasePage(page);
      }
    }
    onProgress && onProgress({ status:'not_found', message:`No Facebook page found for ${lead.name}` });
    return null;
  }

  // Scrape known FB URL
  onProgress && onProgress({ status:'searching', message:`📘 Scraping Facebook: ${knownUrl}` });
  let page;
  try {
    page = await acquirePage();
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
    releasePage(page); page = null;

    if (emails.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found on Facebook: ${emails[0]}` });
      return { email: emails[0], confidence: 80, source: 'facebook' };
    }
    onProgress && onProgress({ status:'not_found', message:`No email on Facebook page` });
  } catch(e) {
    if (page) releasePage(page);
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
    page = await acquirePage();
    await page.setUserAgent(UA);
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
      releasePage(page); page = null;
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
    releasePage(page); page = null;
    return true;
  } catch(e) {
    if (page) releasePage(page);
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
        page = await acquirePage();
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
        releasePage(page); page = null;

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
        if (page) releasePage(page);
      }
    }
    onProgress && onProgress({ status:'not_found', message:`No Instagram page found for ${lead.name}` });
    return null;
  }

  // Scrape known IG URL
  onProgress && onProgress({ status:'searching', message:`📸 Scraping Instagram: ${knownUrl}` });
  let page;
  try {
    page = await acquirePage();
    await page.setUserAgent(UA);
    await page.goto(knownUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const mailtos = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.href.replace('mailto:', '').split('?')[0]);
      return { text, mailtos };
    });
    releasePage(page); page = null;

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
    if (page) releasePage(page);
    onProgress && onProgress({ status:'error', message:`⚠ Instagram scrape failed: ${e.message}` });
  }
  return null;
}

// Step 1: Deep scrape business website — homepage, contact, about, team pages + footer
async function findEmailFromWebsite(lead, onProgress) {
  const website = lead.socials?.website || lead.website || null;
  if (!website) return null;

  const subpages = [
    '', '/contact', '/contact-us', '/contactus', '/about', '/about-us', '/aboutus',
    '/team', '/our-team', '/staff', '/get-in-touch', '/reach-us', '/support'
  ];

  onProgress && onProgress({ status:'searching', message:`🌐 Deep-scanning website: ${website}` });
  const allEmails = [];

  for (const path of subpages) {
    try {
      const url = path ? new URL(path, website).href : website;
      if (!isSafeUrl(url)) continue;
      onProgress && onProgress({ status:'searching', message:`🌐 Checking ${url}` });
      const html = await fetchPage(url);
      const found = extractEmails(html);
      if (found.length) {
        allEmails.push(...found);
        // Return immediately on first find for speed
        onProgress && onProgress({ status:'found', message:`✅ Found on website${path||' homepage'}: ${found[0]}` });
        return { email: found[0], confidence: 90, source: 'website' };
      }
    } catch {}
  }

  onProgress && onProgress({ status:'not_found', message:`No email found on website (checked ${subpages.length} pages)` });
  return null;
}

// Step 1b: Google search to find website, then deep-scrape it
async function findEmailViaGoogle(lead, onProgress) {
  onProgress && onProgress({ status:'searching', message:`🔎 Googling "${lead.name}" to find website...` });
  let page;
  try {
    page = await acquirePage();
    await page.setUserAgent(UA);
    const query = encodeURIComponent(`${lead.name} ${lead.address || ''} contact email`);
    await page.goto(`https://www.google.com/search?q=${query}`, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    // Extract result URLs and emails visible in search results
    const data = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => h.startsWith('http') && !h.includes('google.') && !h.includes('youtube.') &&
          !h.includes('facebook.com') && !h.includes('instagram.com') && !h.includes('yelp.com') &&
          !h.includes('yellowpages.') && !h.includes('bbb.org') && !h.includes('mapquest.'))
        .slice(0, 5);
      const text = document.body.innerText;
      return { links, text };
    });
    releasePage(page); page = null;

    // Check if any emails visible directly in Google results
    const googleEmails = extractEmails(data.text);
    if (googleEmails.length) {
      onProgress && onProgress({ status:'found', message:`✅ Found in Google results: ${googleEmails[0]}` });
      return { email: googleEmails[0], confidence: 75, source: 'google_search' };
    }

    // Try scraping the top result websites
    for (const url of data.links) {
      try {
        if (!isSafeUrl(url)) continue;
        onProgress && onProgress({ status:'searching', message:`🌐 Checking ${new URL(url).hostname}...` });
        const html = await fetchPage(url);
        const emails = extractEmails(html);
        if (emails.length) {
          // Save discovered website to lead
          if (!lead.website) lead.website = url;
          onProgress && onProgress({ status:'found', message:`✅ Found on ${new URL(url).hostname}: ${emails[0]}` });
          return { email: emails[0], confidence: 80, source: 'google_search' };
        }
      } catch {}
    }

    onProgress && onProgress({ status:'not_found', message:`No email found via Google search` });
  } catch(e) {
    if (page) releasePage(page);
    onProgress && onProgress({ status:'error', message:`⚠ Google search failed: ${e.message}` });
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

// Main findEmail pipeline: Website → Google → Facebook → Instagram
async function findEmail(lead, onProgress) {
  onProgress && onProgress({ status:'searching', message:`🔎 Finding email for ${lead.name}...` });
  const sources = [];

  // Step 1: Deep-scrape business website (highest accuracy, matches manual method)
  try {
    const web = await findEmailFromWebsite(lead, onProgress);
    if (web) { markSearched(lead); return web; }
    sources.push('Website: no email');
  } catch(e) {
    sources.push(`Website: error`);
    onProgress && onProgress({ status:'error', message:`⚠ Website scrape failed: ${e.message}` });
  }

  // Step 2: Google search to find website + scrape (for leads without website URL)
  try {
    const gs = await findEmailViaGoogle(lead, onProgress);
    if (gs) { markSearched(lead); return gs; }
    sources.push('Google: no email');
  } catch(e) {
    sources.push(`Google: error`);
    onProgress && onProgress({ status:'error', message:`⚠ Google search failed: ${e.message}` });
  }

  // Step 3: Facebook slug guess + scrape (no login needed)
  try {
    const fb = await findEmailFromFacebook(lead, onProgress);
    if (fb) { markSearched(lead); return fb; }
    sources.push('Facebook: no email');
  } catch(e) {
    sources.push(`Facebook: error`);
    onProgress && onProgress({ status:'error', message:`⚠ Facebook search failed: ${e.message}` });
  }

  // Step 4: Instagram slug guess + scrape (needs IG login)
  try {
    const ig = await findEmailFromInstagram(lead, onProgress);
    if (ig) { markSearched(lead); return ig; }
    sources.push('Instagram: no email');
  } catch(e) {
    sources.push(`Instagram: error`);
    onProgress && onProgress({ status:'error', message:`⚠ Instagram search failed: ${e.message}` });
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
