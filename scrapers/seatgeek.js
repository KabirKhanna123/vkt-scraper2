// VKT SeatGeek Scraper — Fixed search
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RECENT_HOURS = 20;
const DELAY_MS = 1500;
const EVENT_LIMIT = 150;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://seatgeek.com/'
};

async function getEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('events').select('id,name,date,venue')
    .gte('date', today).not('name','ilike','%football 2026 event%').not('name','ilike','%basketball 2026 event%')
    .not('name','ilike','%baseball 2026 event%').not('name','ilike','%hockey 2026 event%')
    .order('date',{ascending:true}).limit(EVENT_LIMIT);
  if (error) { console.error('Events fetch error:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id').eq('event_id', eventId)
    .eq('platform','SeatGeek').gte('scraped_at', since).limit(1);
  return data && data.length > 0;
}

async function searchSeatGeekAPI(query, eventDate) {
  try {
    // Use SeatGeek's internal search API directly — returns clean JSON
    const dateObj = new Date(eventDate + 'T12:00:00');
    const dateFrom = new Date(dateObj.getTime() - 86400000).toISOString().slice(0,10);
    const dateTo = new Date(dateObj.getTime() + 86400000).toISOString().slice(0,10);

    const params = new URLSearchParams({
      q: query,
      per_page: '5',
      'datetime_local.gte': dateFrom,
      'datetime_local.lte': dateTo
    });

    const res = await fetch(`https://seatgeek.com/api/search?${params}`, { headers: HEADERS });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.trim().startsWith('<')) return null;
    const data = JSON.parse(text);
    const events = data.events || data.results || [];
    return events.length ? events[0] : null;
  } catch(e) { return null; }
}

async function searchSeatGeekPage(query, eventDate) {
  try {
    const res = await fetch(
      `https://seatgeek.com/search?q=${encodeURIComponent(query)}`,
      { headers: { ...HEADERS, Accept: 'text/html,*/*' } }
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Try multiple __NEXT_DATA__ paths
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;

    const json = JSON.parse(match[1]);
    const pp = json?.props?.pageProps;

    const events =
      pp?.events ||
      pp?.initialData?.events ||
      pp?.data?.events ||
      pp?.searchResults?.events ||
      pp?.results?.events ||
      [];

    if (!events.length) return null;

    const eventDateObj = new Date(eventDate + 'T12:00:00');
    for (const e of events) {
      const eDate = new Date(e.datetime_local || e.date || '');
      if (!isNaN(eDate) && Math.abs(eDate - eventDateObj) < 86400000 * 2) return e;
    }
    return events[0];
  } catch(e) { return null; }
}

async function searchSeatGeek(eventName, eventDate) {
  // Clean query — keep team names intact, just remove junk
  const query = eventName
    .replace(/\s*[-–]\s*world cup.*/i, '')
    .replace(/tickets\s*[-–]\s*/i, '')
    .replace(/\s*\(match \d+\).*/i, '')
    .replace(/\s*group [a-z].*/i, '')
    .trim()
    .slice(0, 80);

  // Try API first
  let result = await searchSeatGeekAPI(query, eventDate);
  if (result) return result;

  await sleep(400);

  // Fallback to page scrape
  result = await searchSeatGeekPage(query, eventDate);
  if (result) return result;

  // Try shorter query (first 2 words)
  const shortQuery = query.split(' ').slice(0, 3).join(' ');
  if (shortQuery !== query) {
    await sleep(400);
    result = await searchSeatGeekAPI(shortQuery, eventDate);
  }

  return result;
}

async function postSnapshot(payload) {
  const { error } = await supabase.from('volume_snapshots').insert({
    event_id: payload.eventId, event_name: payload.eventName, platform: 'SeatGeek',
    total_listings: payload.totalListings, event_floor: payload.floor,
    section_avg: payload.avg, section_ceiling: payload.ceiling,
    section: null, section_listings: 0, scraped_at: new Date().toISOString()
  });
  if (error) console.error('Snapshot insert error:', error.message);
}

async function run() {
  console.log('VKT SeatGeek Scraper starting...');
  const events = await getEvents();
  console.log(`Found ${events.length} events to process`);
  let scraped = 0, skipped = 0, failed = 0;

  for (const event of events) {
    if (await scrapedRecently(event.id)) { skipped++; continue; }
    await sleep(DELAY_MS);

    const sgEvent = await searchSeatGeek(event.name, event.date);
    if (!sgEvent) { console.log(`  Not found: ${event.name}`); failed++; continue; }

    const floor = safeNum(sgEvent.stats?.lowest_price || sgEvent.lowest_price || 0);
    const avg = safeNum(sgEvent.stats?.average_price || sgEvent.average_price || 0);
    const totalListings = safeNum(sgEvent.stats?.listing_count || sgEvent.listing_count || 0);

    if (!floor) { console.log(`  No price data: ${event.name}`); failed++; continue; }

    await postSnapshot({ eventId: event.id, eventName: event.name, totalListings, floor, avg, ceiling: Math.round(avg * 1.8) });
    console.log(`  ✓ ${event.name}: ${totalListings} listings, floor $${floor}, avg $${avg}`);
    scraped++;
  }
  console.log(`\nSeatGeek done: ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => { console.error('Fatal error:', e); process.exit(1); });
