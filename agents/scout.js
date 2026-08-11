const axios = require('axios');
const BASE_URL = 'https://maps.googleapis.com/maps/api/place';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

function sanitize(str) { return (str||'').replace(/[<>"']/g,'').trim(); }

// ── API call tracking (scoped per run to avoid concurrency issues) ───────
// #20 fix: use a counter object passed per-run instead of module globals
function createCounters() { return { google: 0, free: 0 }; }

// ── OSM Tag Mapping ───────────────────────────────────────────────────────
// Maps ForgeAI business types to OSM tags for Overpass queries.
// #3 fix: added missing types that exist in frontend TYPES array
const OSM_TAGS = {
  // Food & Drink
  restaurant:       [{ key: 'amenity', value: 'restaurant' }],
  cafe:             [{ key: 'amenity', value: 'cafe' }],
  bakery:           [{ key: 'shop', value: 'bakery' }],
  bar:              [{ key: 'amenity', value: 'bar' }, { key: 'amenity', value: 'pub' }],
  grocery_or_supermarket: [{ key: 'shop', value: 'supermarket' }, { key: 'shop', value: 'grocery' }],

  // Personal Care
  beauty_salon:     [{ key: 'shop', value: 'beauty' }],
  hair_care:        [{ key: 'shop', value: 'hairdresser' }],
  barbershop:       [{ key: 'shop', value: 'hairdresser' }],
  massage_therapist:[{ key: 'shop', value: 'massage' }, { key: 'healthcare', value: 'massage_therapist' }],
  tailor:           [{ key: 'shop', value: 'tailor' }],

  // Health & Fitness
  gym:              [{ key: 'leisure', value: 'fitness_centre' }],
  // #4 fix: yoga_studio uses combined tag query — sport=yoga alone returns almost nothing
  yoga_studio:      [{ key: 'leisure', value: 'fitness_centre' }],
  dentist:          [{ key: 'amenity', value: 'dentist' }, { key: 'healthcare', value: 'dentist' }],
  chiropractor:     [{ key: 'healthcare', value: 'chiropractor' }],

  // Home Services
  plumber:          [{ key: 'craft', value: 'plumber' }],
  electrician:      [{ key: 'craft', value: 'electrician' }],
  roofer:           [{ key: 'craft', value: 'roofer' }],
  landscaper:       [{ key: 'craft', value: 'gardener' }, { key: 'shop', value: 'garden_centre' }],
  pool_cleaner:     [{ key: 'shop', value: 'swimming_pool' }],
  pest_control:     [{ key: 'craft', value: 'pest_control' }],

  // Other Services
  auto_repair:      [{ key: 'shop', value: 'car_repair' }],
  photographer:     [{ key: 'craft', value: 'photographer' }],
  florist:          [{ key: 'shop', value: 'florist' }],
  pet_store:        [{ key: 'shop', value: 'pet' }],
  laundry:          [{ key: 'shop', value: 'laundry' }, { key: 'shop', value: 'dry_cleaning' }],
  clothing_store:   [{ key: 'shop', value: 'clothes' }],
  hardware_store:   [{ key: 'shop', value: 'hardware' }, { key: 'shop', value: 'doityourself' }],
  computer_store:   [{ key: 'shop', value: 'computer' }, { key: 'shop', value: 'electronics' }],
  // #3 fix: added missing types from frontend
  wedding_officiant:[{ key: 'amenity', value: 'place_of_worship' }, { key: 'office', value: 'religion' }],
  veterinary_care:  [{ key: 'amenity', value: 'veterinary' }],
  car_wash:         [{ key: 'amenity', value: 'car_wash' }],
  locksmith:        [{ key: 'craft', value: 'locksmith' }],
  moving_company:   [{ key: 'office', value: 'moving_company' }],
  insurance_agency: [{ key: 'office', value: 'insurance' }],
  real_estate_agency:[{ key: 'office', value: 'estate_agent' }],
  accounting:       [{ key: 'office', value: 'accountant' }],
  lawyer:           [{ key: 'office', value: 'lawyer' }],
  travel_agency:    [{ key: 'shop', value: 'travel_agency' }],
  jewelry_store:    [{ key: 'shop', value: 'jewelry' }],
  shoe_store:       [{ key: 'shop', value: 'shoes' }],
  furniture_store:  [{ key: 'shop', value: 'furniture' }],

  // Agencies — unlikely in OSM, will usually fall back to Google
  marketing_agency:        [{ key: 'office', value: 'marketing' }],
  digital_agency:          [{ key: 'office', value: 'marketing' }],
  creative_agency:         [{ key: 'office', value: 'advertising' }],
  advertising_agency:      [{ key: 'office', value: 'advertising' }],
  social_media_agency:     [{ key: 'office', value: 'marketing' }],
  seo_agency:              [{ key: 'office', value: 'marketing' }],
  pr_agency:               [{ key: 'office', value: 'marketing' }],
  web_design_agency:       [{ key: 'office', value: 'it' }],
  video_production_agency: [{ key: 'office', value: 'advertising' }],
  branding_agency:         [{ key: 'office', value: 'advertising' }],
  content_marketing_agency:[{ key: 'office', value: 'marketing' }],
  email_marketing_agency:  [{ key: 'office', value: 'marketing' }],
  media_buying_agency:     [{ key: 'office', value: 'advertising' }],
};

// ── Nominatim Geocoder ────────────────────────────────────────────────────
// #8 fix: LRU cache with max 500 entries instead of unbounded Map
const GEO_CACHE_MAX = 500;
const geoCache = new Map();
let lastNominatimCall = 0;
// #9 fix: mutex to serialize Nominatim calls (prevents rate limit violations)
let nominatimLock = Promise.resolve();

async function geocodeCity(city, counters) {
  if (geoCache.has(city)) return geoCache.get(city);

  // Serialize Nominatim calls to respect 1 req/sec rate limit
  const unlock = nominatimLock;
  let resolve;
  nominatimLock = new Promise(r => { resolve = r; });
  await unlock;

  // Double-check cache after waiting
  if (geoCache.has(city)) { resolve(); return geoCache.get(city); }

  try {
    // Rate limit: 1 req/sec
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastNominatimCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatimCall = Date.now();

    const res = await axios.get(NOMINATIM_URL, {
      params: { q: city, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'ForgeAI-Scout/1.0 (contact@forgeaiagent.com)' },
      timeout: 8000,
    });
    // #19 fix: only count after successful request
    counters.free++;
    if (res.data && res.data.length > 0) {
      const result = { lat: parseFloat(res.data[0].lat), lon: parseFloat(res.data[0].lon) };
      // #8 fix: evict oldest entry if cache is full
      if (geoCache.size >= GEO_CACHE_MAX) {
        const oldest = geoCache.keys().next().value;
        geoCache.delete(oldest);
      }
      geoCache.set(city, result);
      return result;
    }
  } catch (e) {
    // Geocoding failed — will fall back to Google
  } finally {
    resolve();
  }
  return null;
}

// ── Overpass Search ───────────────────────────────────────────────────────
function buildOverpassQuery(tags, lat, lon, radiusM) {
  const parts = tags.map(t =>
    `node["${t.key}"="${t.value}"]["name"](around:${radiusM},${lat},${lon});` +
    `way["${t.key}"="${t.value}"]["name"](around:${radiusM},${lat},${lon});`
  ).join('\n');
  return `[out:json][timeout:30];(\n${parts}\n);out center tags;`;
}

function parseOverpassResult(el, businessType, location) {
  const tags = el.tags || {};
  if (!tags.name) return null;

  const parts = [];
  if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (tags['addr:street']) parts.push(tags['addr:street']);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  if (tags['addr:state']) parts.push(tags['addr:state']);
  if (tags['addr:postcode']) parts.push(tags['addr:postcode']);
  const address = parts.join(', ') || `${location} area`;

  const lat = el.lat || (el.center && el.center.lat);
  const lon = el.lon || (el.center && el.center.lon);

  return {
    name: tags.name,
    address,
    phone: tags.phone || tags['contact:phone'] || null,
    website: tags.website || tags['contact:website'] || null,
    rating: 'N/A',
    reviews: 0,
    type: businessType,
    location,
    google_maps_url: lat && lon ? `https://www.google.com/maps?q=${lat},${lon}` : '',
    status: 'New',
    found_at: new Date().toISOString(),
    _source: 'osm',
    _lat: lat,
    _lon: lon,
  };
}

async function overpassSearch(businessType, lat, lon, radiusM, needed, counters) {
  const tags = OSM_TAGS[businessType];
  if (!tags) return { elements: [], skipped: true };

  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  try {
    // #17 fix: Axios timeout 35s (30s Overpass timeout + 5s buffer)
    const res = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ForgeAI-Scout/1.0' },
      timeout: 35000,
    });
    // #19 fix: count after success
    counters.free++;
    return { elements: (res.data.elements || []).slice(0, needed * 3), skipped: false };
  } catch (e) {
    return { elements: [], skipped: false };
  }
}

// ── Google Places (kept as fallback) ──────────────────────────────────────
async function searchPlaces(query, location, needed, counters) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Google Places API key not set.');
  const results = [];
  let pageToken = null, pages = 0;
  do {
    pages++;
    const params = { query: `${query} in ${location}`, key };
    if (pageToken) params.pagetoken = pageToken;
    const res = await axios.get(`${BASE_URL}/textsearch/json`, { params, timeout: 10000 });
    // #11 fix: only count after successful request
    counters.google++;
    if (res.data.status === 'REQUEST_DENIED') throw new Error('Google API key invalid: ' + (res.data.error_message||''));
    if (res.data.status === 'ZERO_RESULTS') break;
    results.push(...(res.data.results||[]));
    if (results.length >= needed * 2) break;
    pageToken = res.data.next_page_token || null;
    if (pageToken) await new Promise(r=>setTimeout(r,2500));
  } while (pageToken && pages < 3);
  return results;
}

// #11 fix: check key before calling, only count on success
async function getDetails(placeId, counters) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get(`${BASE_URL}/details/json`, {
      params: { place_id: placeId, fields: 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,business_status,url', key },
      timeout: 8000
    });
    counters.google++;
    if (res.data.result) return res.data.result;
  } catch { /* single attempt, no retry */ }
  return null;
}

// ── Google enrichment for OSM leads missing phone ─────────────────────────
// #18 fix: only set _source to 'osm+google' when data actually changed
async function enrichWithGoogle(lead, counters) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return lead;

  try {
    const res = await axios.get(`${BASE_URL}/findplacefromtext/json`, {
      params: {
        input: `${lead.name} ${lead.address}`,
        inputtype: 'textquery',
        fields: 'place_id',
        key,
      },
      timeout: 8000,
    });
    counters.google++;
    const candidates = res.data.candidates || [];
    if (candidates.length === 0) return lead;

    const d = await getDetails(candidates[0].place_id, counters);
    if (!d) return lead;

    let updated = false;
    if (!lead.phone || lead.phone === 'N/A') { const v = d.formatted_phone_number; if (v) { lead.phone = v; updated = true; } }
    if (!lead.website && d.website) { lead.website = d.website; updated = true; }
    if (lead.rating === 'N/A' && d.rating) { lead.rating = d.rating; updated = true; }
    if (lead.reviews === 0 && d.user_ratings_total) { lead.reviews = d.user_ratings_total; updated = true; }
    if (!lead.google_maps_url && d.url) { lead.google_maps_url = d.url; updated = true; }
    if (updated) lead._source = 'osm+google';
  } catch { /* enrichment failed, keep lead as-is */ }
  return lead;
}

// ── Address normalization for cross-source dedup ─────────────────────────
// #10 fix: normalize addresses to reduce false non-matches across OSM/Google
function normalizeForDedup(name, address) {
  const n = (name || '').toLowerCase().trim()
    .replace(/[''`]/g, '')
    .replace(/\s+/g, ' ');
  const a = (address || '').toLowerCase().trim()
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\broad\b/g, 'rd')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
    .replace(/,?\s*usa$/i, '')
    .replace(/,?\s*united states$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[,.\s]+$/g, '');
  return `${n}|${a}`;
}

// ── Scout Flow ────────────────────────────────────────────────────────────
// #14 fix: accept runningTotal to track cumulative leads across types
async function scoutType({ location, businessType, maxLeads, seenIds, filter, counters, runningTotal }, onProgress) {
  const needed = parseInt(maxLeads) || 20;
  let leads = [];

  // ── Phase 1: Try free sources (Overpass via Nominatim) ──
  const geo = await geocodeCity(location, counters);

  if (geo) {
    // #3 fix: tell user if type has no OSM mapping
    const hasOsmTags = !!OSM_TAGS[businessType];
    if (!hasOsmTags) {
      onProgress({ status: 'found', message: `[${businessType}] No OSM mapping — skipping free search, using Google...` });
    } else {
      onProgress({ status: 'found', message: `[${businessType}] Searching free sources (OSM)...` });
    }
    const radiusM = 25000;
    const { elements: raw, skipped } = await overpassSearch(businessType, geo.lat, geo.lon, radiusM, needed, counters);

    if (raw.length > 0) {
      onProgress({ status: 'found', message: `[${businessType}] Found ${raw.length} from OSM, processing...` });

      for (const el of raw) {
        if (leads.length >= needed) break;
        let lead = parseOverpassResult(el, businessType, location);
        if (!lead) continue;

        // #10 fix: normalized dedup key
        const dedup = normalizeForDedup(lead.name, lead.address);
        if (seenIds.has(dedup)) continue;
        seenIds.add(dedup);

        // #2 fix: enrich BEFORE filter check so enriched website is caught
        onProgress({ status: 'checking', message: `[${businessType}] Processing: ${lead.name}`, leadsFound: runningTotal.count + leads.length });

        if (!lead.phone) {
          lead = await enrichWithGoogle(lead, counters);
        }

        // Apply filter AFTER enrichment
        if (filter === 'no_website' && lead.website) continue;
        if (filter === 'has_website' && !lead.website) continue;

        leads.push(lead);
        const ratingStr = lead.rating !== 'N/A' ? `${lead.rating}★ (${lead.reviews} reviews)` : 'OSM lead';
        // #14 fix: use runningTotal for cumulative count
        onProgress({ status: 'lead_found', message: `✓ ${lead.name}, ${ratingStr}`, lead, leadsFound: runningTotal.count + leads.length });
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // ── Phase 2: Fall back to Google TextSearch if free sources found too few ──
  if (leads.length < needed) {
    const remaining = needed - leads.length;
    const hasGoogleKey = !!process.env.GOOGLE_PLACES_API_KEY;

    if (hasGoogleKey) {
      onProgress({ status: 'found', message: `[${businessType}] ${leads.length > 0 ? `Got ${leads.length} from OSM, need ${remaining} more — ` : ''}Searching Google Places...` });

      let raw = [];
      try { raw = await searchPlaces(businessType, location, remaining, counters); }
      catch(e) { onProgress({ status: 'error', message: `[${businessType}] Google fallback error: ${e.message}` }); }

      const fresh = raw.filter(p => {
        if (seenIds.has(p.place_id)) return false;
        seenIds.add(p.place_id);
        // #10 fix: normalized dedup
        const nameKey = normalizeForDedup(p.name, p.formatted_address || '');
        if (seenIds.has(nameKey)) return false;
        seenIds.add(nameKey);
        return true;
      });

      for (const place of fresh) {
        if (leads.length >= needed) break;
        const d = await getDetails(place.place_id, counters);
        if (!d) continue;
        onProgress({ status: 'checking', message: `[${businessType}] Checking: ${d.name||place.name}`, leadsFound: runningTotal.count + leads.length });
        if (filter === 'no_website' && d.website) continue;
        if (filter === 'has_website' && !d.website) continue;
        if (d.business_status && d.business_status !== 'OPERATIONAL') continue;
        // #13 fix: don't skip unrated businesses — they're still valid leads
        const lead = {
          name: d.name || place.name || 'Unknown',
          address: d.formatted_address || '',
          phone: d.formatted_phone_number || 'N/A',
          website: d.website || null,
          rating: d.rating || 'N/A',
          reviews: d.user_ratings_total || 0,
          type: businessType,
          location,
          google_maps_url: d.url || '',
          status: 'New',
          found_at: new Date().toISOString(),
          _source: 'google',
        };
        leads.push(lead);
        onProgress({ status: 'lead_found', message: `✓ ${lead.name}, ${lead.rating !== 'N/A' ? lead.rating + '★ (' + lead.reviews + ' reviews)' : 'new listing'}`, lead, leadsFound: runningTotal.count + leads.length });
        await new Promise(r => setTimeout(r, 250));
      }
    } else if (leads.length === 0) {
      onProgress({ status: 'error', message: `[${businessType}] No results from OSM and no Google API key configured.` });
    }
  }

  // Source breakdown
  const osmCount = leads.filter(l => l._source === 'osm').length;
  const enrichedCount = leads.filter(l => l._source === 'osm+google').length;
  const googleCount = leads.filter(l => l._source === 'google').length;
  const sourceMsg = [];
  if (osmCount > 0) sourceMsg.push(`${osmCount} free`);
  if (enrichedCount > 0) sourceMsg.push(`${enrichedCount} free+enriched`);
  if (googleCount > 0) sourceMsg.push(`${googleCount} Google`);

  // #14 fix: update running total
  runningTotal.count += leads.length;

  onProgress({ status: 'type_done', message: `[${businessType}] Complete: ${leads.length} leads (${sourceMsg.join(', ') || 'none'})` });
  return leads;
}

async function runScout({ location, businessTypes, businessType, maxLeads=20, filter='no_website' }, onProgress) {
  // #20 fix: per-run counters instead of module globals
  const counters = createCounters();
  const loc = sanitize(location);
  const types = (businessTypes?.length ? businessTypes : [businessType]).filter(Boolean);
  if (!types.length) throw new Error('No business types selected');

  // #12 fix: show filter label for all filter values including no_website
  const filterLabels = { all: ' (all businesses)', has_website: ' (with website)', no_website: ' (without website only)' };
  const filterLabel = filterLabels[filter] || '';
  onProgress({ status: 'start', message: `Searching ${types.length} type(s) in "${loc}"${filterLabel}... (free sources first, Google fallback)` });

  const seenIds = new Set();
  const all = [];
  // #14 fix: shared running total across types
  const runningTotal = { count: 0 };
  for (const t of types) {
    const results = await scoutType({ location: loc, businessType: t, maxLeads: parseInt(maxLeads)||20, seenIds, filter, counters, runningTotal }, onProgress);
    all.push(...results);
  }

  // #10 fix: final dedup with normalized keys
  const seen = new Set();
  const unique = all.filter(l => {
    const k = normalizeForDedup(l.name, l.address);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Clean internal fields before returning
  unique.forEach(l => { delete l._source; delete l._lat; delete l._lon; });

  const costMsg = counters.google > 0
    ? `${counters.google} Google API calls, ${counters.free} free calls`
    : `${counters.free} free calls, 0 Google API calls ($0 cost!)`;
  onProgress({ status: 'complete', message: `Done, ${unique.length} quality leads found (${costMsg})`, leads: unique, leadsFound: unique.length });
  return unique;
}

module.exports = { runScout };
