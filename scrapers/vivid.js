// VKT VividSeats Scraper
// Uses HTTP requests to scrape VividSeats listing data
// No browser needed — VividSeats returns listing data in JSON embedded in page HTML
// Runs via GitHub Actions 2x/day

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RECENT_HOURS = 20;
const DELAY_MS = 1200;
const EVENT_LIMIT = 150;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.vividseats.com/',
  'Origin': 'https://www.vividseats.com'
};

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

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .eq('platform', 'VividSeats')
    .gte('scraped_at', since)
    .limit(1);
  return data && data.length > 0;
}

// ─── SEARCH VIVIDSEATS ───
async function searchVividSeats(eventName, eventDate) {
  try {
    const query = eventName
      .replace(/tickets\s*[-–]\s*/i, '')
      .replace(/\s+at\s+.*/i, '')
      .trim()
      .slice(0, 60);

    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://www.vividseats.com/hermes/api/v1/productions?query=${encoded}&rows=5`,
      { headers: HEADERS }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const productions = data.productions || data.results || data;
    if (!Array.isArray(productions) || !productions.length) return null;

    // Match by date
    const eventDateObj = new Date(eventDate + 'T12:00:00');
    for (const p of productions) {
      const pDate = new Date(p.localDate || p.date || p.eventDate || '');
      if (!isNaN(pDate) && Math.abs(pDate - eventDateObj) < 86400000 * 2) {
        return p;
      }
    }

    return productions[0]; // fallback to first result
  } catch(e) {
    console.error('VividSeats search error:', e.message);
    return null;
  }
}

// ─── GET LISTINGS FOR A VIVIDSEATS PRODUCTION ───
async function getVividListings(productionId) {
  try {
    // VividSeats API for listings
    const res = await fetch(
      `https://www.vividseats.com/hermes/api/v1/listings?productionId=${productionId}&rows=100&sortBy=price&sortDirection=asc`,
      { headers: HEADERS }
    );

    if (!res.ok) {
      // Fallback: try scraping the production page HTML for embedded JSON
      return await getVividListingsFromPage(productionId);
    }

    const data = await res.json();
    return data.listings || data.results || data;
  } catch(e) {
    console.error('VividSeats listings error:', e.message);
    return null;
  }
}

async function getVividListingsFromPage(productionId) {
  try {
    const res = await fetch(
      `https://www.vividseats.com/production/${productionId}`,
      { headers: { ...HEADERS, Accept: 'text/html' } }
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Extract embedded JSON data
    const match = html.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]*?\})<\/script>/);
    if (!match) return null;

    const json = JSON.parse(match[1]);
    // Navigate the Next.js data structure to find listings
    const pageProps = json?.props?.pageProps;
    const listings = pageProps?.listings || pageProps?.initialListings || pageProps?.data?.listings;
    return listings || null;
  } catch(e) {
    return null;
  }
}

// ─── POST SNAPSHOT ───
async function postSnapshot(payload) {
  const { error } = await supabase.from('volume_snapshots').insert({
    event_id: payload.eventId,
    event_name: payload.eventName,
    platform: 'VividSeats',
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

// ─── EXTRACT PRICES FROM LISTINGS ───
function extractPrices(listings) {
  if (!listings || !Array.isArray(listings)) return [];
  return listings
    .map(l => safeNum(
      l.price || l.pricePerTicket || l.ticketPrice ||
      l.listingPrice || l.salePrice || l.amount || 0
    ))
    .filter(p => p > 1 && p < 25000)
    .sort((a, b) => a - b);
}

// ─── MAIN ───
async function run() {
  console.log('VKT VividSeats Scraper starting...');
  const events = await getEvents();
  console.log(`Found ${events.length} events to process`);

  let scraped = 0, skipped = 0, failed = 0;

  for (const event of events) {
    const recent = await scrapedRecently(event.id);
    if (recent) { skipped++; continue; }

    await sleep(DELAY_MS);

    // Search VividSeats
    const vsEvent = await searchVividSeats(event.name, event.date);
    if (!vsEvent) {
      console.log(`  Not found on VividSeats: ${event.name}`);
      failed++;
      continue;
    }

    const productionId = vsEvent.id || vsEvent.productionId;
    if (!productionId) { failed++; continue; }

    await sleep(500);

    // Get listings
    const listings = await getVividListings(productionId);
    const prices = extractPrices(listings);

    if (!prices.length) {
      console.log(`  No listings on VividSeats: ${event.name}`);
      failed++;
      continue;
    }

    const floor = prices[0];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const ceiling = prices[prices.length - 1];
    const totalListings = Array.isArray(listings) ? listings.length : 0;

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

  console.log(`\nVividSeats scrape complete: ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => { console.error('Fatal error:', e); process.exit(1); });
