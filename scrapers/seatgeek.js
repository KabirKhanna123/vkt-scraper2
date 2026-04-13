Output

// VKT SeatGeek Scraper — Bulk pull + match approach
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function proxyUrl(url) {
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`;
}

async function getSupabaseEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() + 6);
  const end = cutoff.toISOString().slice(0, 10);
  const { data, error } = await supabase.from('events').select('id,name,date,venue')
    .gte('date', today).lte('date', end)
    .not('name','ilike','%football 2026 event%').not('name','ilike','%basketball 2026 event%')
    .not('name','ilike','%baseball 2026 event%').not('name','ilike','%hockey 2026 event%')
    .order('date', { ascending: true });
  if (error) { console.error('Supabase error:', error.message); return []; }
  return data || [];
}

async function fetchSeatGeekPage(path) {
  try {
    const res = await fetch(proxyUrl(`https://seatgeek.com${path}`));
    if (!res.ok) return [];
    const html = await res.text();
    if (html.trim().startsWith('{')) {
      const data = JSON.parse(html);
      return data.events || data.results || [];
    }
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    const json = JSON.parse(match[1]);
    const pp = json?.props?.pageProps;
    return pp?.events || pp?.initialData?.events || pp?.data?.events || pp?.searchResults?.events || [];
  } catch(e) { console.error(`Page fetch error ${path}:`, e.message); return []; }
}

async function getAllSeatGeekEvents() {
  const allEvents = []; const seen = new Set();
  const pages = ['/nba','/mlb','/nhl','/nfl','/mls','/concerts','/sports',
    '/search?q=world+cup+2026','/search?q=NBA+playoffs','/search?q=NHL+playoffs'];

  for (const page of pages) {
    await sleep(1500);
    console.log(`  Fetching: ${page}`);
    const events = await fetchSeatGeekPage(page);
    for (const e of events) {
      const key = String(e.id || e.slug || '');
      if (key && !seen.has(key)) { seen.add(key); allEvents.push(e); }
    }
    console.log(`  → ${allEvents.length} total`);
  }
  return allEvents;
}

function normalizeVenue(v) {
  if (!v) return '';
  return v.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\b(stadium|arena|center|centre|field|park|theatre|theater)\b/g,'').replace(/\s+/g,' ').trim();
}

function venueScore(v1, v2) {
  if (!v1 || !v2) return 0;
  const n1 = normalizeVenue(v1); const n2 = normalizeVenue(v2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 10;
  if (n1.includes(n2.slice(0,8)) || n2.includes(n1.slice(0,8))) return 7;
  const w1 = n1.split(' ')[0]; const w2 = n2.split(' ')[0];
  if (w1 && w2 && w1 === w2 && w1.length > 3) return 5;
  return 0;
}

function matchEvents(sgEvents, sbEvents) {
  const matches = [];
  for (const sg of sgEvents) {
    const sgDate = new Date(sg.datetime_local || sg.date || '');
    if (isNaN(sgDate)) continue;
    const floor = safeNum(sg.stats?.lowest_price || sg.lowest_price || 0);
    const avg = safeNum(sg.stats?.average_price || sg.average_price || 0);
    const listings = safeNum(sg.stats?.listing_count || sg.listing_count || 0);
    if (!floor) continue;

    let best = null, bestScore = 0;
    for (const sb of sbEvents) {
      const sbDate = new Date((sb.date||'') + 'T12:00:00');
      if (isNaN(sbDate)) continue;
      const dayDiff = Math.abs(sgDate - sbDate) / 86400000;
      let score = 0;
      if (dayDiff < 0.5) score += 20;
      else if (dayDiff < 1.5) score += 10;
      else continue;
      score += venueScore(sg.venue?.name || '', sb.venue || '');
      if (score > bestScore) { bestScore = score; best = sb; }
    }
    if (best && bestScore >= 15) {
      matches.push({ sb: best, floor, avg, listings, ceiling: Math.round(avg * 1.8), score: bestScore });
    }
  }
  return matches;
}

async function getRecentlyScraped() {
  const since = new Date(Date.now() - 20 * 3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('event_id')
    .eq('platform','SeatGeek').gte('scraped_at', since);
  return new Set((data||[]).map(r => r.event_id));
}

async function postSnapshot(m) {
  const { error } = await supabase.from('volume_snapshots').insert({
    event_id: m.sb.id, event_name: m.sb.name, platform: 'SeatGeek',
    total_listings: m.listings, event_floor: m.floor, section_avg: m.avg,
    section_ceiling: m.ceiling, section: null, section_listings: 0,
    scraped_at: new Date().toISOString()
  });
  if (error) console.error('Insert error:', error.message);
}

async function run() {
  console.log('VKT SeatGeek Scraper (bulk+match) starting...');
  if (!SCRAPER_KEY) { console.log('No SCRAPER_API_KEY'); process.exit(1); }

  const [sbEvents, recentlyScraped] = await Promise.all([getSupabaseEvents(), getRecentlyScraped()]);
  console.log(`Supabase events: ${sbEvents.length}, recently scraped: ${recentlyScraped.size}`);

  console.log('\nFetching SeatGeek events...');
  const sgEvents = await getAllSeatGeekEvents();
  console.log(`SeatGeek events pulled: ${sgEvents.length}`);

  console.log('\nMatching...');
  const matches = matchEvents(sgEvents, sbEvents);
  console.log(`Matched: ${matches.length}`);

  let saved = 0, skipped = 0;
  for (const m of matches) {
    if (recentlyScraped.has(m.sb.id)) { skipped++; continue; }
    await postSnapshot(m);
    console.log(`  ✓ ${m.sb.name} (score:${m.score}): floor $${m.floor}, ${m.listings} listings`);
    saved++;
  }
  console.log(`\nDone: ${saved} saved, ${skipped} skipped`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
