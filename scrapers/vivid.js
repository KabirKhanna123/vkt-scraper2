// VKT VividSeats Scraper — Fixed endpoint
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
  'Referer': 'https://www.vividseats.com/',
  'x-requested-with': 'XMLHttpRequest'
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
    .eq('platform','VividSeats').gte('scraped_at', since).limit(1);
  return data && data.length > 0;
}

async function searchVividSeats(eventName, eventDate) {
  try {
    const query = eventName.replace(/tickets\s*[-–]\s*/i,'').replace(/\s+at\s+.*/i,'').trim().slice(0,60);

    // Use VividSeats catalog search API
    const res = await fetch(
      `https://www.vividseats.com/api/1.0/catalog/productions?headlinerId=&keyword=${encodeURIComponent(query)}&rows=5`,
      { headers: HEADERS }
    );

    if (!res.ok) return null;
    const text = await res.text();

    // Check if we got HTML instead of JSON
    if (text.trim().startsWith('<')) return null;

    const data = JSON.parse(text);
    const productions = data.productions || data.results || (Array.isArray(data) ? data : []);
    if (!productions.length) return null;

    const eventDateObj = new Date(eventDate + 'T12:00:00');
    for (const p of productions) {
      const pDate = new Date(p.localDate || p.date || p.eventDate || p.productionDate || '');
      if (!isNaN(pDate) && Math.abs(pDate - eventDateObj) < 86400000 * 2) return p;
    }
    return productions[0];
  } catch(e) {
    console.error('VividSeats search error:', e.message);
    return null;
  }
}

async function getVividListings(productionId) {
  try {
    const res = await fetch(
      `https://www.vividseats.com/api/1.0/productions/${productionId}/listings?rows=100&sortBy=PRICE&sortDirection=ASC`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const text = await res.text();
    if (text.trim().startsWith('<')) return null;
    const data = JSON.parse(text);
    return data.listings || data.ticketListings || (Array.isArray(data) ? data : null);
  } catch(e) {
    console.error('VividSeats listings error:', e.message);
    return null;
  }
}

function extractPrices(listings) {
  if (!listings || !Array.isArray(listings)) return [];
  return listings
    .map(l => safeNum(l.price || l.pricePerTicket || l.ticketPrice || l.listingPrice || l.amount || 0))
    .filter(p => p > 1 && p < 25000)
    .sort((a, b) => a - b);
}

async function postSnapshot(payload) {
  const { error } = await supabase.from('volume_snapshots').insert({
    event_id: payload.eventId, event_name: payload.eventName, platform: 'VividSeats',
    total_listings: payload.totalListings, event_floor: payload.floor,
    section_avg: payload.avg, section_ceiling: payload.ceiling,
    section: null, section_listings: 0, scraped_at: new Date().toISOString()
  });
  if (error) console.error('Snapshot insert error:', error.message);
}

async function run() {
  console.log('VKT VividSeats Scraper starting...');
  const events = await getEvents();
  console.log(`Found ${events.length} events to process`);
  let scraped = 0, skipped = 0, failed = 0;

  for (const event of events) {
    if (await scrapedRecently(event.id)) { skipped++; continue; }
    await sleep(DELAY_MS);

    const vsEvent = await searchVividSeats(event.name, event.date);
    if (!vsEvent) { console.log(`  Not found: ${event.name}`); failed++; continue; }

    const productionId = vsEvent.id || vsEvent.productionId;
    if (!productionId) { failed++; continue; }

    await sleep(600);
    const listings = await getVividListings(productionId);
    const prices = extractPrices(listings);

    if (!prices.length) { console.log(`  No listings: ${event.name}`); failed++; continue; }

    const floor = prices[0];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const ceiling = prices[prices.length - 1];

    await postSnapshot({ eventId: event.id, eventName: event.name, totalListings: prices.length, floor, avg, ceiling });
    console.log(`  ✓ ${event.name}: ${prices.length} listings, floor $${floor}, avg $${avg}`);
    scraped++;
  }
  console.log(`\nVividSeats done: ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => { console.error('Fatal error:', e); process.exit(1); });
