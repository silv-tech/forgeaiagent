const axios = require('axios');
const BASE_URL = 'https://maps.googleapis.com/maps/api/place';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

function sanitize(str) { return (str||'').replace(/[<>"']/g,'').trim(); }

// ── API call tracking ─────────────────────────────────────────────────────
let googleCallCount = 0;
let freeCallCount = 0;
function resetCallCounts() { googleCallCount = 0; freeCallCount = 0; }
function getCallCount() { return googleCallCount; }
function getFreeCallCount() { return freeCallCount; }

// ── OSM Tag Mapping ───────────────────────────────────────────────────────
// Maps ForgeAI business types to OSM tags for Overpass queries.
// Format: { key, value } or array of fallbacks to try in order.
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
  yoga_studio:      [{ key: 'leisure', value: 'fitness_centre' }, { key: 'sport', value: 'yoga' }],
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
const geoCache = new Map();
let lastNominatimCall = 0;

async function geocodeCity(city) {
  if (geoCache.has(city)) return geoCache.get(city);

  // Rate limit: 1 req/sec
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastNominatimCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatimCall = Date.now();

  freeCallCount++;
  try {
    const res = await axios.get(NOMINATIM_URL, {
      params: { q: city, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'ForgeAI-Scout/1.0 (contact@forgeaiagent.com)' },
      timeout: 8000,
    });
    if (res.data && res.data.length > 0) {
      const result = { lat: parseFloat(res.data[0].lat), lon: parseFloat(res.data[0].lon) };
      geoCache.set(city, result);
      return result;
    }
  } catch (e) {
    // Geocoding failed — will fall back to Google
  }
  return null;
}

// ── Overpass Search ───────────────────────────────────────────────────────
function buildOverpassQuery(tags, lat, lon, radiusM) {
  // Build union of all tag queries within a radius
  const parts = tags.map(t =>
    `node["${t.key}"="${t.value}"]["name"](around:${radiusM},${lat},${lon});` +
    `way["${t.key}"="${t.value}"]["name"](around:${radiusM},${lat},${lon});`
  ).join('\n');
  return `[out:json][timeout:30];(\n${parts}\n);out center tags;`;
}

function parseOverpassResult(el, businessType, location) {
  const tags = el.tags || {};
  if (!tags.name) return null; // Skip unnamed entries

  // Build address from OSM addr:* tags
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

async function overpassSearch(businessType, lat, lon, radiusM, needed) {
  const tags = OSM_TAGS[businessType];
  if (!tags) return [];

  const query = buildOverpassQuery(tags, lat, lon, radiusM);
  freeCallCount++;
  try {
    const res = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ForgeAI-Scout/1.0' },
      timeout: 45000,
    });
    return (res.data.elements || []).slice(0, needed * 3); // Get extra to account for filtering
  } catch (e) {
    // Overpass timeout or error — will fall back to Google
    return [];
  }
}

// ── Google Places (kept as fallback) ──────────────────────────────────────
async function searchPlaces(query, location, needed) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Google Places API key not set.');
  const results = [];
  let pageToken = null, pages = 0;
  do {
    pages++;
    googleCallCount++;
    const params = { query: `${query} in ${location}`, key };
    if (pageToken) params.pagetoken = pageToken;
    const res = await axios.get(`${BASE_URL}/textsearch/json`, { params, timeout: 10000 });
    if (res.data.status === 'REQUEST_DENIED') throw new Error('Google API key invalid: ' + (res.data.error_message||''));
    if (res.data.status === 'ZERO_RESULTS') break;
    results.push(...(res.data.results||[]));
    if (results.length >= needed * 2) break;
    pageToken = res.data.next_page_token || null;
    if (pageToken) await new Promise(r=>setTimeout(r,2500));
  } while (pageToken && pages < 3);
  return results;
}

async function getDetails(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  googleCallCount++;
  try {
    const res = await axios.get(`${BASE_URL}/details/json`, {
      params: { place_id: placeId, fields: 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,business_status,url', key },
      timeout: 8000
    });
    if (res.data.result) return res.data.result;
  } catch { /* single attempt, no retry */ }
  return null;
}

// ── Google enrichment for OSM leads missing phone ─────────────────────────
async function enrichWithGoogle(lead) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return lead; // No key, can't enrich

  // Use findplacefromtext (cheaper than textsearch) to locate the business
  googleCallCount++;
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
    const candidates = res.data.candidates || [];
    if (candidates.length === 0) return lead;

    const d = await getDetails(candidates[0].place_id);
    if (!d) return lead;

    // Fill in missing data only
    if (!lead.phone || lead.phone === 'N/A') lead.phone = d.formatted_phone_number || lead.phone;
    if (!lead.website) lead.website = d.website || null;
    if (lead.rating === 'N/A' && d.rating) lead.rating = d.rating;
    if (lead.reviews === 0 && d.user_ratings_total) lead.reviews = d.user_ratings_total;
    if (!lead.google_maps_url && d.url) lead.google_maps_url = d.url;
    lead._source = 'osm+google';
  } catch { /* enrichment failed, keep lead as-is */ }
  return lead;
}

// ── Scout Flow ────────────────────────────────────────────────────────────
async function scoutType({ location, businessType, maxLeads, seenIds, filter }, onProgress) {
  const needed = parseInt(maxLeads) || 20;
  let leads = [];

  // ── Phase 1: Try free sources (Overpass via Nominatim) ──
  const geo = await geocodeCity(location);

  if (geo) {
    onProgress({ status: 'found', message: `[${businessType}] Searching free sources (OSM)...` });
    const radiusM = 25000; // 25km radius
    const raw = await overpassSearch(businessType, geo.lat, geo.lon, radiusM, needed);

    if (raw.length > 0) {
      onProgress({ status: 'found', message: `[${businessType}] Found ${raw.length} from OSM, processing...` });

      for (const el of raw) {
        if (leads.length >= needed) break;
        let lead = parseOverpassResult(el, businessType, location);
        if (!lead) continue;

        // Dedup by name+address
        const dedup = `${lead.name}|${lead.address}`.toLowerCase();
        if (seenIds.has(dedup)) continue;
        seenIds.add(dedup);

        // Apply filter
        if (filter === 'no_website' && lead.website) continue;
        if (filter === 'has_website' && !lead.website) continue;
        // Skip rating filter for OSM leads — OSM has no rating data

        onProgress({ status: 'checking', message: `[${businessType}] Processing: ${lead.name}`, leadsFound: leads.length });

        // Enrich with Google only if lead is missing phone
        if (!lead.phone) {
          lead = await enrichWithGoogle(lead);
        }

        leads.push(lead);
        const ratingStr = lead.rating !== 'N/A' ? `${lead.rating}★ (${lead.reviews} reviews)` : 'OSM lead';
        onProgress({ status: 'lead_found', message: `✓ ${lead.name}, ${ratingStr}`, lead, leadsFound: leads.length });
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
      try { raw = await searchPlaces(businessType, location, remaining); }
      catch(e) { onProgress({ status: 'error', message: `[${businessType}] Google fallback error: ${e.message}` }); }

      const fresh = raw.filter(p => {
        if (seenIds.has(p.place_id)) return false;
        seenIds.add(p.place_id);
        // Also check name-based dedup
        const nameKey = `${p.name}|${p.formatted_address||''}`.toLowerCase();
        if (seenIds.has(nameKey)) return false;
        seenIds.add(nameKey);
        return true;
      });

      for (const place of fresh) {
        if (leads.length >= needed) break;
        const d = await getDetails(place.place_id);
        if (!d) continue;
        onProgress({ status: 'checking', message: `[${businessType}] Checking: ${d.name||place.name}`, leadsFound: leads.length });
        if (filter === 'no_website' && d.website) continue;
        if (filter === 'has_website' && !d.website) continue;
        if (d.business_status && d.business_status !== 'OPERATIONAL') continue;
        if (!d.rating && !d.user_ratings_total) continue;
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
        onProgress({ status: 'lead_found', message: `✓ ${lead.name}, ${lead.rating}★ (${lead.reviews} reviews)`, lead, leadsFound: leads.length });
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

  onProgress({ status: 'type_done', message: `[${businessType}] Complete: ${leads.length} leads (${sourceMsg.join(', ') || 'none'})` });
  return leads;
}

async function runScout({ location, businessTypes, businessType, maxLeads=20, filter='no_website' }, onProgress) {
  resetCallCounts();
  const loc = sanitize(location);
  const types = (businessTypes?.length ? businessTypes : [businessType]).filter(Boolean);
  if (!types.length) throw new Error('No business types selected');

  const filterLabel = filter === 'all' ? ' (all businesses)' : filter === 'has_website' ? ' (with website)' : '';
  onProgress({ status: 'start', message: `Searching ${types.length} type(s) in "${loc}"${filterLabel}... (free sources first, Google fallback)` });

  const seenIds = new Set();
  const all = [];
  for (const t of types) {
    const results = await scoutType({ location: loc, businessType: t, maxLeads: parseInt(maxLeads)||20, seenIds, filter }, onProgress);
    all.push(...results);
  }

  const seen = new Set();
  const unique = all.filter(l => {
    const k = `${l.name}|${l.address}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Clean internal fields before returning
  unique.forEach(l => { delete l._source; delete l._lat; delete l._lon; });

  const costMsg = googleCallCount > 0
    ? `${googleCallCount} Google API calls, ${freeCallCount} free calls`
    : `${freeCallCount} free calls, 0 Google API calls ($0 cost!)`;
  onProgress({ status: 'complete', message: `✅ Done, ${unique.length} quality leads found (${costMsg})`, leads: unique, leadsFound: unique.length });
  return unique;
}

module.exports = { runScout };
