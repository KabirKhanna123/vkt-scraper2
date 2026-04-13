// VKT SeatGeek Scraper — No API key required
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
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
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

async function searchSeatGeek(eventName, eventDate) {
  try {
    const query = eventName.replace(/tickets\s*[-–]\s*/i,'').replace(/\s+at\s+.*/i,'').trim().slice(0,60);
    const res = await fetch(`https://seatgeek.com/search?q=${encodeURIComponent(query)}`, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
    if (!match) return null;
    const json = JSON.parse(match[1]);
    const events = json?.props?.pageProps?.events || json?.props?.pageProps?.initialData?.events || [];
    if (!events.length) return null;
    const eventDateObj = new Date(eventDate + 'T12:00:00');
    for (const e of events) {
      const eDate = new Date(e.datetime_local || e.date || '');
      if (!isNaN(eDate) && Math.abs(eDate - eventDateObj) < 86400000 * 2) return e;
    }
    return events[0];
  } catch(e) { console.error('SeatGeek search error:', e.message); return null; }
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
  console.log('VKT SeatGeek Scraper (no-API mode) starting...');
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
