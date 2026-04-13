// VKT VividSeats Scraper — via ScraperAPI
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const RECENT_HOURS = 20;
const DELAY_MS = 2000;
const EVENT_LIMIT = 150;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function proxyUrl(url) {
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=false`;
}

function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch(e) { return null; }
}

function extractPricesFromHtml(html) {
  const prices = [];
  const regex = /\$\s*(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val > 1 && val < 25000) prices.push(val);
  }
  return [...new Set(prices)].sort((a, b) => a - b);
}

async function getEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('events').select('id,name,date,venue')
    .gte('date', today).not('name','ilike','%football 2026 event%')
    .not('name','ilike','%basketball 2026 event%')
    .not('name','ilike','%baseball 2026 event%')
    .not('name','ilike','%hockey 2026 event%')
    .order('date',{ascending:true}).limit(EVENT_LIMIT);
  if (error) { console.error('Events fetch error:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id')
    .eq('event_id', eventId).eq('platform','VividSeats')
    .gte('scraped_at', since).limit(1);
  return data && data.length > 0;
}

async function searchVividSeats(eventName, eventDate) {
  try {
    const query = eventName
      .replace(/tickets\s*[-–]\s*/i, '')
      .replace(/\s*\*.*?\*\s*/g, '')
      .replace(/\s*[-–]\s*world cup.*/i, '')
      .trim().slice(0, 80);

    const targetUrl = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(query)}`;
    const res = await fetch(proxyUrl(targetUrl));
    if (!res.ok) { console.log(`  VS HTTP ${res.status}`); return null; }

    const html = await res.text();
    if (html.trim().startsWith('<') && html.includes('<!DOCTYPE')) {
      console.log(`  VS returned HTML error page for: ${eventName}`);
      return null;
    }

    const json = extractNextData(html);
    if (json) {
      const pp = json?.props?.pageProps;
      const productions =
        pp?.productions ||
        pp?.searchResults?.productions ||
        pp?.data?.productions ||
        pp?.results || [];

      if (Array.isArray(productions) && productions.length) {
        const eventDateObj = new Date(eventDate + 'T12:00:00');
        for (const p of productions) {
          const pDate = new Date(p.localDate || p.date || p.eventDate || '');
          if (!isNaN(pDate) && Math.abs(pDate - eventDateObj) < 86400000 * 2) return { production: p };
        }
        return { production: productions[0] };
      }
    }

    // Fallback — extract prices from raw HTML
    const prices = extractPricesFromHtml(html);
    return prices.length ? { prices } : null;
  } catch(e) { console.error('VividSeats search error:', e.message); return null; }
}

async function getProductionListings(productionId) {
  try {
    const targetUrl = `https://www.vividseats.com/production/${productionId}`;
    const res = await fetch(proxyUrl(targetUrl));
    if (!res.ok) return null;
    const html = await res.text();

    const json = extractNextData(html);
    if (json) {
      const pp = json?.props?.pageProps;
      const listings = pp?.listings || pp?.ticketListings || pp?.data?.listings || pp?.initialListings || [];
      if (Array.isArray(listings) && listings.length) {
        return listings.map(l => safeNum(l.price || l.pricePerTicket || l.ticketPrice || 0))
          .filter(p => p > 1 && p < 25000).sort((a, b) => a - b);
      }
    }
    return extractPricesFromHtml(html).slice(0, 50);
  } catch(e) { return null; }
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
  if (!SCRAPER_KEY) { console.log('No SCRAPER_API_KEY set'); process.exit(1); }
  const events = await getEvents();
  console.log(`Found ${events.length} events to process`);
  let scraped = 0, skipped = 0, failed = 0;

  for (const event of events) {
    if (await scrapedRecently(event.id)) { skipped++; continue; }
    await sleep(DELAY_MS);

    const result = await searchVividSeats(event.name, event.date);
    if (!result) { console.log(`  Not found: ${event.name}`); failed++; continue; }

    let prices = result.prices || [];

    if (!prices.length && result.production) {
      const productionId = result.production.id || result.production.productionId;
      if (productionId) {
        await sleep(800);
        prices = await getProductionListings(productionId) || [];
      }
      if (!prices.length) {
        const floor = safeNum(result.production.minPrice || result.production.lowestPrice || result.production.startingPrice || 0);
        if (floor) prices = [floor];
      }
    }

    if (!prices.length) { console.log(`  No prices: ${event.name}`); failed++; continue; }

    const floor = prices[0];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const ceiling = prices[prices.length - 1];

    await postSnapshot({ eventId: event.id, eventName: event.name, totalListings: prices.length, floor, avg, ceiling });
    console.log(`  ✓ ${event.name}: floor $${floor}, avg $${avg}`);
    scraped++;
  }
  console.log(`\nVividSeats done: ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => { console.error('Fatal error:', e); process.exit(1); });
