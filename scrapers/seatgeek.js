// VKT SeatGeek Scraper
// Uses SeatGeek API to fetch listing data for all events in Supabase
// Runs via GitHub Actions 2x/day

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SG_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const SG_CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET;
const RECENT_HOURS = 20;
const DELAY_MS = 800; // rate limit buffer
const EVENT_LIMIT = 150;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ─── FETCH EVENTS FROM SUPABASE ───
async function getEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue')
    .gte('date', today)
    .not('name', 'ilike', '%football 2026 event%')
    .not('name', 'ilike', '%basketball 2026 event%')
    .not('name', 'ilike', '%baseball 2026 event%')
    .not('name', 'ilike', '%hockey 2026 event%')
    .order('date', { ascending: true })
    .limit(EVENT_LIMIT);

  if (error) { console.error('Events fetch error:', error.message); return []; }
  return data || [];
}

// ─── CHECK IF RECENTLY SCRAPED ───
async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .eq('platform', 'SeatGeek')
    .gte('scraped_at', since)
    .limit(1);
  return data && data.length > 0;
}

// ─── SEARCH SEATGEEK FOR AN EVENT ───
async function searchSeatGeek(eventName, eventDate) {
  try {
    // Clean event name for search
    const query = eventName
      .replace(/tickets\s*[-–]\s*/i, '')
      .replace(/\s+at\s+.*/i, '')
      .replace(/[-–]\s*world cup.*/i, '')
      .trim()
      .slice(0, 60);

    const dateObj = new Date(eventDate + 'T12:00:00');
    const dateFrom = new Date(dateObj.getTime() - 86400000).toISOString().slice(0, 10);
    const dateTo = new Date(dateObj.getTime() + 86400000).toISOString().slice(0, 10);

    const params = new URLSearchParams({
      q: query,
      'datetime_local.gte': dateFrom,
      'datetime_local.lte': dateTo,
      per_page: '5',
      client_id: SG_CLIENT_ID,
      client_secret: SG_CLIENT_SECRET
    });

    const res = await fetch(`https://api.seatgeek.com/2/events?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.events && data.events.length > 0 ? data.events[0] : null;
  } catch(e) {
    console.error('SeatGeek search error:', e.message);
    return null;
  }
}

// ─── GET LISTINGS FOR A SEATGEEK EVENT ───
async function getSeatGeekListings(sgEventId) {
  try {
    const params = new URLSearchParams({
      event_id: sgEventId,
      per_page: '100',
      sort: 'lowest_price.asc',
      client_id: SG_CLIENT_ID,
      client_secret: SG_CLIENT_SECRET
    });

    const res = await fetch(`https://api.seatgeek.com/2/listings?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch(e) {
    console.error('SeatGeek listings error:', e.message);
    return null;
  }
}

// ─── POST SNAPSHOT TO SUPABASE ───
async function postSnapshot(payload) {
  const { error } = await supabase.from('volume_snapshots').insert({
    event_id: payload.eventId,
    event_name: payload.eventName,
    platform: 'SeatGeek',
    total_listings: payload.totalListings,
    event_floor: payload.floor,
    section_avg: payload.avg,
    section_ceiling: payload.ceiling,
    section: null,
    section_listings: 0,
    scraped_at: new Date().toISOString()
  });
  if (error) console.error('Snapshot insert error:', error.message);
}

// ─── MAIN ───
async function run() {
  if (!SG_CLIENT_ID) {
    console.log('No SeatGeek API credentials — skipping. Add SEATGEEK_CLIENT_ID and SEATGEEK_CLIENT_SECRET to GitHub secrets.');
    process.exit(0);
  }

  console.log('VKT SeatGeek Scraper starting...');
  const events = await getEvents();
  console.log(`Found ${events.length} events to process`);

  let scraped = 0, skipped = 0, failed = 0;

  for (const event of events) {
    // Skip if recently scraped
    const recent = await scrapedRecently(event.id);
    if (recent) { skipped++; continue; }

    await sleep(DELAY_MS);

    // Search SeatGeek for matching event
    const sgEvent = await searchSeatGeek(event.name, event.date);
    if (!sgEvent) {
      console.log(`  Not found on SeatGeek: ${event.name}`);
      failed++;
      continue;
    }

    // Get listings
    const listings = await getSeatGeekListings(sgEvent.id);
    if (!listings || !listings.listings || !listings.listings.length) {
      console.log(`  No listings on SeatGeek: ${event.name}`);
      failed++;
      continue;
    }

    const prices = listings.listings
      .map(l => safeNum(l.lowest_price || l.price))
      .filter(p => p > 0)
      .sort((a, b) => a - b);

    if (!prices.length) { failed++; continue; }

    const floor = prices[0];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const ceiling = prices[prices.length - 1];
    const totalListings = listings.meta?.total || listings.listings.length;

    await postSnapshot({
      eventId: event.id,
      eventName: event.name,
      totalListings,
      floor,
      avg,
      ceiling
    });

    console.log(`  ✓ ${event.name}: ${totalListings} listings, floor $${floor}, avg $${avg}`);
    scraped++;
  }

  console.log(`\nSeatGeek scrape complete: ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => { console.error('Fatal error:', e); process.exit(1); });
