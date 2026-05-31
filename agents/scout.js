const axios = require('axios');
const BASE_URL = 'https://maps.googleapis.com/maps/api/place';

function sanitize(str) { return (str||'').replace(/[<>"']/g,'').trim(); }

// Track API calls per run for cost awareness
let apiCallCount = 0;
function resetCallCount() { apiCallCount = 0; }
function getCallCount() { return apiCallCount; }

async function searchPlaces(query, location, needed) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Google Places API key not set.');
  const results = [];
  let pageToken = null, pages = 0;
  do {
    pages++;
    apiCallCount++;
    const params = { query: `${query} in ${location}`, key };
    if (pageToken) params.pagetoken = pageToken;
    const res = await axios.get(`${BASE_URL}/textsearch/json`, { params, timeout: 10000 });
    if (res.data.status === 'REQUEST_DENIED') throw new Error('Google API key invalid: ' + (res.data.error_message||''));
    if (res.data.status === 'ZERO_RESULTS') break;
    results.push(...(res.data.results||[]));
    // Stop early if we have enough raw results (2x needed to account for filtering)
    if (results.length >= needed * 2) break;
    pageToken = res.data.next_page_token || null;
    if (pageToken) await new Promise(r=>setTimeout(r,2500));
  } while (pageToken && pages < 3);
  return results;
}

async function getDetails(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  apiCallCount++;
  try {
    const res = await axios.get(`${BASE_URL}/details/json`, {
      params: { place_id: placeId, fields: 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,business_status,url', key },
      timeout: 8000
    });
    if (res.data.result) return res.data.result;
  } catch { /* single attempt, no retry */ }
  return null;
}

async function scoutType({ location, businessType, maxLeads, seenIds, filter }, onProgress) {
  // Only fetch as many raw results as we realistically need
  let raw = [];
  try { raw = await searchPlaces(businessType, location, maxLeads); }
  catch(e) { onProgress({ status:'error', message:`[${businessType}] ${e.message}` }); return []; }

  const fresh = raw.filter(p => { if(seenIds.has(p.place_id)) return false; seenIds.add(p.place_id); return true; });
  onProgress({ status:'found', message:`[${businessType}] ${fresh.length} places, filtering...` });

  const leads = [];
  for (const place of fresh) {
    // Check BEFORE making expensive API call
    if (leads.length >= maxLeads) break;
    const d = await getDetails(place.place_id);
    if (!d) continue;
    onProgress({ status:'checking', message:`[${businessType}] Checking: ${d.name||place.name}`, leadsFound: leads.length });
    if (filter === 'no_website' && d.website) continue;
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
    };
    leads.push(lead);
    onProgress({ status:'lead_found', message:`✓ ${lead.name}, ${lead.rating}★ (${lead.reviews} reviews)`, lead, leadsFound: leads.length });
    await new Promise(r=>setTimeout(r,250));
  }
  onProgress({ status:'type_done', message:`[${businessType}] Complete, ${leads.length} leads` });
  return leads;
}

async function runScout({ location, businessTypes, businessType, maxLeads=20, filter='no_website' }, onProgress) {
  resetCallCount();
  const loc = sanitize(location);
  const types = (businessTypes?.length ? businessTypes : [businessType]).filter(Boolean);
  if (!types.length) throw new Error('No business types selected');
  onProgress({ status:'start', message:`Searching ${types.length} type(s) in "${loc}"${filter==='all'?' (all businesses)':''}...` });
  const seenIds = new Set();
  // Run sequentially instead of parallel to control costs
  const all = [];
  for (const t of types) {
    const results = await scoutType({ location:loc, businessType:t, maxLeads:parseInt(maxLeads)||20, seenIds, filter }, onProgress);
    all.push(...results);
  }
  const seen = new Set();
  const unique = all.filter(l => { const k=`${l.name}|${l.address}`.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; });
  onProgress({ status:'complete', message:`✅ Done, ${unique.length} quality leads found (${getCallCount()} API calls used)`, leads:unique, leadsFound:unique.length });
  return unique;
}

module.exports = { runScout };
