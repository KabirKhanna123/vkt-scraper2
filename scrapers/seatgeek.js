// VKT SeatGeek Scraper — Bulk pull + match approach (improved)
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

if (!SCRAPER_KEY) {
  console.error('Missing SCRAPER_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function proxyUrl(url) {
  return `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render=true`;
}

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVenue(v) {
  return normalizeText(v)
    .replace(/\b(stadium|arena|center|centre|field|park|theatre|theater|pavilion|coliseum|garden)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(name) {
  return normalizeText(name)
    .replace(/\btickets\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function venueScore(v1, v2) {
  if (!v1 || !v2) return 0;

  const n1 = normalizeVenue(v1);
  const n2 = normalizeVenue(v2);

  if (!n1 || !n2) return 0;
  if (n1 === n2) return 10;
  if (n1.includes(n2) || n2.includes(n1)) return 8;

  const w1 = new Set(n1.split(' '));
  const w2 = new Set(n2.split(' '));
  let overlap = 0;
  for (const w of w1) {
    if (w2.has(w) && w.length > 3) overlap++;
  }
  if (overlap >= 2) return 6;
  if (overlap >= 1) return 4;

  return 0;
}

function nameScore(n1, n2) {
  if (!n1 || !n2) return 0;

  const a = normalizeName(n1);
  const b = normalizeName(n2);

  if (!a || !b) return 0;
  if (a === b) return 12;
  if (a.includes(b) || b.includes(a)) return 8;

  const w1 = new Set(a.split(' '));
  const w2 = new Set(b.split(' '));
  let overlap = 0;
  for (const w of w1) {
    if (w2.has(w) && w.length > 2) overlap++;
  }
  if (overlap >= 4) return 7;
  if (overlap >= 2) return 4;

  return 0;
}

function parseSeatGeekEventsFromJson(json) {
  if (!json || typeof json !== 'object') return [];

  const candidates = [
    json?.props?.pageProps?.events,
    json?.props?.pageProps?.initialData?.events,
    json?.props?.pageProps?.data?.events,
    json?.props?.pageProps?.searchResults?.events,
    json?.props?.pageProps?.search?.events,
    json?.events,
    json?.results,
    json?.data?.events,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }

  return [];
}

function extractSeatGeekFields(event) {
  const venueName =
    event?.venue?.name ||
    event?.venue?.display_location ||
    event?.venue?.extended_address ||
    '';

  const floor =
    safeNum(event?.stats?.lowest_price) ||
    safeNum(event?.lowest_price) ||
    safeNum(event?.stats?.lowest_sg_base_price) ||
    0;

  const avg =
    safeNum(event?.stats?.average_price) ||
    safeNum(event?.average_price) ||
    safeNum(event?.stats?.lowest_sg_base_price) ||
    floor ||
    0;

  const listings =
    safeNum(event?.stats?.listing_count) ||
    safeNum(event?.listing_count) ||
    safeNum(event?.stats?.visible_listing_count) ||
    0;

  const dt =
    event?.datetime_local ||
    event?.datetime_utc ||
    event?.date ||
    '';

  return {
    id: String(event?.id || event?.slug || ''),
    title: event?.title || event?.name || '',
    venue: venueName,
    datetime: dt,
    floor,
    avg,
    listings,
  };
}

async function getSupabaseEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + 6);
  const end = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue')
    .gte('date', today)
    .lte('date', end)
    .not('name', 'ilike', '%football 2026 event%')
    .not('name', 'ilike', '%basketball 2026 event%')
    .not('name', 'ilike', '%baseball 2026 event%')
    .not('name', 'ilike', '%hockey 2026 event%')
    .order('date', { ascending: true });

  if (error) {
    console.error('Supabase error:', error.message);
    return [];
  }

  return data || [];
}

async function fetchSeatGeekPage(path) {
  const url = `https://seatgeek.com${path}`;

  try {
    const res = await fetch(proxyUrl(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/json',
      },
    });

    if (!res.ok) {
      console.log(`  HTTP ${res.status} for ${path}`);
      return [];
    }

    const html = await res.text();
    if (!html || html.length < 500) {
      console.log(`  Very short response for ${path}`);
      return [];
    }

    const lower = html.toLowerCase();
    if (
      lower.includes('captcha') ||
      lower.includes('access denied') ||
      lower.includes('temporarily blocked') ||
      lower.includes('verify you are human')
    ) {
      console.log(`  Blocked response detected for ${path}`);
      return [];
    }

    if (html.trim().startsWith('{')) {
      try {
        const json = JSON.parse(html);
        const events = parseSeatGeekEventsFromJson(json);
        console.log(`  Parsed JSON response: ${events.length} events from ${path}`);
        return events;
      } catch (e) {
        console.log(`  JSON parse failed for ${path}: ${e.message}`);
      }
    }

    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
      console.log(`  No __NEXT_DATA__ found for ${path}`);
      console.log(`  HTML preview: ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
      return [];
    }

    let json;
    try {
      json = JSON.parse(match[1]);
    } catch (e) {
      console.log(`  __NEXT_DATA__ JSON parse failed for ${path}: ${e.message}`);
      return [];
    }

    const events = parseSeatGeekEventsFromJson(json);
    console.log(`  Parsed __NEXT_DATA__: ${events.length} events from ${path}`);
    return events;
  } catch (e) {
    console.error(`  Page fetch error ${path}:`, e.message);
    return [];
  }
}

async function getAllSeatGeekEvents() {
  const allEvents = [];
  const seen = new Set();

  const pages = [
    '/nba',
    '/mlb',
    '/nhl',
    '/nfl',
    '/mls',
    '/concerts',
    '/sports',
    '/search?q=world+cup+2026',
    '/search?q=NBA+playoffs',
    '/search?q=NHL+playoffs',
    '/search?q=MLB',
    '/search?q=concert',
  ];

  for (const page of pages) {
    await sleep(2000);
    console.log(`Fetching: ${page}`);

    const events = await fetchSeatGeekPage(page);

    for (const raw of events) {
      const e = extractSeatGeekFields(raw);
      if (!e.id) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      allEvents.push(e);
    }

    console.log(`  → ${allEvents.length} total unique SeatGeek events`);
  }

  return allEvents;
}

function matchEvents(sgEvents, sbEvents) {
  const matches = [];
  const usedSb = new Set();

  for (const sg of sgEvents) {
    const sgDate = new Date(sg.datetime);
    if (isNaN(sgDate)) continue;

    if (!sg.floor && !sg.listings) continue;

    let best = null;
    let bestScore = 0;

    for (const sb of sbEvents) {
      const sbDate = new Date((sb.date || '') + 'T12:00:00');
      if (isNaN(sbDate)) continue;

      const dayDiff = Math.abs(sgDate - sbDate) / 86400000;
      if (dayDiff > 1.5) continue;

      let score = 0;

      if (dayDiff < 0.5) score += 20;
      else if (dayDiff < 1.5) score += 10;

      score += venueScore(sg.venue, sb.venue || '');
      score += nameScore(sg.title, sb.name || '');

      if (score > bestScore) {
        bestScore = score;
        best = sb;
      }
    }

    if (best && bestScore >= 10) {
      const key = `${sg.id}::${best.id}`;
      if (usedSb.has(key)) continue;
      usedSb.add(key);

      matches.push({
        sb: best,
        floor: sg.floor,
        avg: sg.avg || sg.floor,
        listings: sg.listings,
        ceiling: Math.round((sg.avg || sg.floor || 0) * 1.8),
        score: bestScore,
        sgTitle: sg.title,
        sgVenue: sg.venue,
        sgDate: sg.datetime,
      });
    }
  }

  return matches;
}

async function getRecentlyScraped() {
  const since = new Date(Date.now() - 20 * 3600000).toISOString();

  const { data, error } = await supabase
    .from('volume_snapshots')
    .select('event_id')
    .eq('platform', 'SeatGeek')
    .gte('scraped_at', since);

  if (error) {
    console.error('Recent scrape query error:', error.message);
    return new Set();
  }

  return new Set((data || []).map(r => r.event_id));
}

async function postSnapshot(m) {
  const payload = {
    event_id: m.sb.id,
    event_name: m.sb.name,
    platform: 'SeatGeek',
    total_listings: m.listings,
    event_floor: m.floor,
    section_avg: m.avg,
    section_ceiling: m.ceiling,
    section: null,
    section_listings: 0,
    scraped_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('volume_snapshots').insert(payload);
  if (error) {
    console.error(`Insert error for ${m.sb.name}:`, error.message);
    return false;
  }

  return true;
}

async function run() {
  console.log('VKT SeatGeek Scraper (bulk+match improved) starting...');

  const [sbEvents, recentlyScraped] = await Promise.all([
    getSupabaseEvents(),
    getRecentlyScraped(),
  ]);

  console.log(`Supabase events: ${sbEvents.length}`);
  console.log(`Recently scraped SeatGeek events: ${recentlyScraped.size}`);

  console.log('\nFetching SeatGeek events...');
  const sgEvents = await getAllSeatGeekEvents();
  console.log(`SeatGeek events pulled: ${sgEvents.length}`);

  if (!sgEvents.length) {
    console.log('\nNo SeatGeek events were pulled. Most likely causes:');
    console.log('- ScraperAPI blocked response');
    console.log('- SeatGeek page structure changed');
    console.log('- __NEXT_DATA__ missing');
    process.exit(0);
  }

  console.log('\nMatching...');
  const matches = matchEvents(sgEvents, sbEvents);
  console.log(`Matched: ${matches.length}`);

  if (!matches.length) {
    console.log('\nNo matches found. Most likely causes:');
    console.log('- event names differ too much');
    console.log('- venue names differ too much');
    console.log('- dates are not lining up');
    process.exit(0);
  }

  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const m of matches) {
    if (recentlyScraped.has(m.sb.id)) {
      skipped++;
      continue;
    }

    const ok = await postSnapshot(m);

    if (ok) {
      console.log(
        `  ✓ ${m.sb.name} | SG: ${m.sgTitle} | score:${m.score} | floor:$${m.floor} | listings:${m.listings}`
      );
      saved++;
    } else {
      failed++;
    }

    await sleep(150);
  }

  console.log(`\nDone: ${saved} saved, ${skipped} skipped, ${failed} failed`);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
