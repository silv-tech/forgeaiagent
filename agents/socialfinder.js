const https = require('https');
const http = require('http');

function getPlacesKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Google Places API key not set.');
  return key;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

// Fetch a URL and return raw HTML (follows redirects, timeout 8s)
function fetchPage(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const timer = setTimeout(() => reject(new Error('Timeout')), 8000);
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentForge/1.0)' } }, res => {
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

// Extract social media URLs from HTML
function extractSocialLinks(html) {
  const socials = { instagram: null, facebook: null, tiktok: null, twitter: null, linkedin: null, youtube: null };
  const patterns = [
    { key: 'instagram', regex: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?/gi },
    { key: 'facebook',  regex: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9.]+\/?/gi },
    { key: 'tiktok',    regex: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._]+\/?/gi },
    { key: 'twitter',   regex: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/?/gi },
    { key: 'linkedin',  regex: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9-]+\/?/gi },
    { key: 'youtube',   regex: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@)[a-zA-Z0-9_-]+\/?/gi },
  ];
  for (const { key, regex } of patterns) {
    const matches = html.match(regex);
    if (matches && matches.length) {
      // Filter out generic/share links
      const valid = matches.find(m =>
        !m.includes('/sharer') && !m.includes('/share') && !m.includes('/intent') &&
        !m.includes('/hashtag') && !m.includes('/p/') && !m.includes('/reel/')
      );
      if (valid) socials[key] = { url: valid.replace(/\/$/, ''), source: 'website' };
    }
  }
  return socials;
}

// Get business website from Google Places
async function getBusinessWebsite(lead) {
  const key = getPlacesKey();
  const query = encodeURIComponent(`${lead.name} ${lead.address}`);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name&key=${key}`;
  const searchRes = await httpsGet(url);
  if (!searchRes.candidates?.length) return null;
  const placeId = searchRes.candidates[0].place_id;
  const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=website,url&key=${key}`;
  const detailRes = await httpsGet(detailUrl);
  return detailRes.result?.website || null;
}

// Main function
async function findSocialMedia(lead, onProgress) {
  onProgress({ status: 'start', message: `🚀 Starting social media search for ${lead.name}...` });

  let websiteUrl = lead.website || null;
  let socials = { instagram: null, facebook: null, tiktok: null, twitter: null, linkedin: null, youtube: null };

  // Step 1: Get business website
  if (!websiteUrl) {
    onProgress({ status: 'searching', message: `📍 Looking up ${lead.name} website via Google Places...` });
    try {
      websiteUrl = await getBusinessWebsite(lead);
      if (websiteUrl) {
        onProgress({ status: 'found', message: `🌐 Found website: ${websiteUrl}` });
      } else {
        onProgress({ status: 'not_found', message: `❌ No website found on Google Places` });
      }
    } catch(e) {
      onProgress({ status: 'error', message: `⚠ Places lookup failed: ${e.message}` });
    }
  }

  // Step 2: If we have a website, scrape it for social links
  if (websiteUrl) {
    onProgress({ status: 'searching', message: `🔍 Scanning ${websiteUrl} for social links...` });
    try {
      const html = await fetchPage(websiteUrl);
      socials = extractSocialLinks(html);
      const foundNames = Object.entries(socials).filter(([,v]) => v).map(([k]) => k);
      if (foundNames.length) {
        onProgress({ status: 'found', message: `✅ Found on website: ${foundNames.join(', ')}` });
      } else {
        onProgress({ status: 'not_found', message: `No social links found on website` });
      }
    } catch(e) {
      onProgress({ status: 'error', message: `⚠ Could not fetch website: ${e.message}` });
    }
  }

  // Step 3: For any platform still not found, try Google Maps URL page
  if (!socials.instagram && !socials.facebook) {
    if (lead.google_maps_url) {
      onProgress({ status: 'searching', message: `🔍 Checking Google Maps listing...` });
      try {
        const html = await fetchPage(lead.google_maps_url);
        const fallback = extractSocialLinks(html);
        Object.entries(fallback).forEach(([k, v]) => {
          if (v && !socials[k]) socials[k] = v;
        });
      } catch(e) {
        // Silently skip, Google Maps pages often block bots
      }
    }
  }

  const found = Object.values(socials).filter(v => v !== null).length;
  const result = {
    ...socials,
    website: websiteUrl,
    foundCount: found,
    searchedAt: new Date().toISOString()
  };

  onProgress({
    status: 'done',
    message: `🏁 Done, found ${found} social profile${found !== 1 ? 's' : ''} for ${lead.name}`
  });

  return result;
}

module.exports = { findSocialMedia };
