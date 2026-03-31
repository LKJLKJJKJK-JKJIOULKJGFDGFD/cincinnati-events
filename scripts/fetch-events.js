'use strict';

const fs = require('fs');
const path = require('path');

const TM_KEY = process.env.TICKETMASTER_API_KEY;
const SG_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const KNOWN_EVENTS_PATH = path.join(process.cwd(), 'known-events.json');

// ─── Known Events (new-since-yesterday tracking) ──────────────────────────────

function loadKnownIds() {
  try {
    if (!fs.existsSync(KNOWN_EVENTS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(KNOWN_EVENTS_PATH, 'utf8'));
    return new Set(data.eventIds ?? []);
  } catch {
    return null;
  }
}

function saveKnownIds(events) {
  const data = {
    lastUpdated: new Date().toISOString(),
    eventIds: events.map(e => e.id),
  };
  fs.writeFileSync(KNOWN_EVENTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function getDateRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 365);
  return { start, end };
}

function toISODate(date) {
  return date.toISOString().split('T')[0];
}

function formatDisplayDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${day}, ${year}`;
}

function formatTime(timeStr) {
  if (!timeStr) return 'TBA';
  const [hours, minutes] = timeStr.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${String(minutes).padStart(2, '0')} ${period}`;
}

function normalizeStr(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Ticketmaster ─────────────────────────────────────────────────────────────

async function fetchTMCategory(category, startDT, endDT) {
  const events = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages && page < 5) {
    const params = new URLSearchParams({
      apikey: TM_KEY,
      city: 'Cincinnati',
      stateCode: 'OH',
      radius: '50',
      unit: 'miles',
      classificationName: category,
      startDateTime: startDT,
      endDateTime: endDT,
      size: '200',
      page: String(page),
      sort: 'date,asc',
    });

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`;
    console.log(`  TM ${category} page ${page}...`);
    const res = await fetch(url);
    if (!res.ok) { console.error(`  TM HTTP ${res.status} for ${category}`); break; }

    const data = await res.json();
    if (data.fault) { console.error(`  TM API error (${category}): ${data.fault.faultstring}`); break; }

    totalPages = data.page?.totalPages ?? 1;
    const pageEvents = data._embedded?.events ?? [];
    events.push(...pageEvents);
    page++;
    if (pageEvents.length === 0) break;
  }

  return events;
}

async function fetchTicketmaster() {
  if (!TM_KEY) { console.warn('No TICKETMASTER_API_KEY set — skipping.'); return []; }

  const { start, end } = getDateRange();
  const startDT = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const endDT   = end.toISOString().replace(/\.\d{3}Z$/, 'Z');

  try {
    const [musicRaw, comedyRaw, artsRaw] = await Promise.all([
      fetchTMCategory('music',  startDT, endDT),
      fetchTMCategory('comedy', startDT, endDT),
      fetchTMCategory('arts',   startDT, endDT),
    ]);

    const all = [...musicRaw, ...comedyRaw, ...artsRaw];
    const normalized = all.map(normalizeTM).filter(Boolean);
    console.log(`Ticketmaster: ${normalized.length} events`);
    return normalized;
  } catch (err) {
    console.error('Ticketmaster fetch failed:', err.message);
    return [];
  }
}

function normalizeTM(event) {
  try {
    const venue = event._embedded?.venues?.[0];
    if (!venue) return null;
    const date = event.dates?.start?.localDate;
    if (!date) return null;

    const seg = event.classifications?.[0]?.segment?.name?.toLowerCase() ?? '';
    let category = 'Music';
    if (seg.includes('comedy')) category = 'Comedy';
    else if (seg.includes('arts') || seg.includes('theatre') || seg.includes('theater')) category = 'Theater';

    const time = event.dates?.start?.localTime ?? null;
    return {
      id: `tm-${event.id}`,
      name: event.name,
      venue: venue.name,
      date,
      time,
      dateSortKey: `${date}T${time ?? '23:59:00'}`,
      category,
      url: event.url,
      source: 'ticketmaster',
    };
  } catch {
    return null;
  }
}

// ─── SeatGeek ─────────────────────────────────────────────────────────────────

async function fetchSeatGeek() {
  if (!SG_CLIENT_ID) { console.warn('No SEATGEEK_CLIENT_ID set — skipping.'); return []; }

  const { start, end } = getDateRange();
  const startStr = toISODate(start);
  const endStr   = toISODate(end);

  const TYPES = ['concert', 'comedy_show', 'theater', 'broadway_tickets_national'];
  const events = [];

  try {
    for (const type of TYPES) {
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= 3) {
        const params = new URLSearchParams({
          client_id: SG_CLIENT_ID,
          lat: '39.1031',
          lon: '-84.5120',
          range: '50mi',
          type,
          'datetime_local.gte': `${startStr}T00:00:00`,
          'datetime_local.lte': `${endStr}T23:59:59`,
          per_page: '500',
          page: String(page),
          sort: 'datetime_local.asc',
        });

        console.log(`  SG ${type} page ${page}...`);
        const url = `https://api.seatgeek.com/2/events?${params}`;
        const res = await fetch(url);
        if (!res.ok) { console.error(`  SG HTTP ${res.status} for ${type}`); break; }

        const data = await res.json();
        if (!data.events) break;

        const normalized = data.events.map(e => normalizeSG(e, type)).filter(Boolean);
        events.push(...normalized);

        const total = data.meta?.total ?? 0;
        const perPage = data.meta?.per_page ?? 500;
        hasMore = page * perPage < total;
        page++;
      }
    }

    console.log(`SeatGeek: ${events.length} events`);
    return events;
  } catch (err) {
    console.error('SeatGeek fetch failed:', err.message);
    return [];
  }
}

function normalizeSG(event, type) {
  try {
    const dt = event.datetime_local;
    if (!dt) return null;
    const [date, timePart] = dt.split('T');

    let category = 'Music';
    if (type === 'comedy_show') category = 'Comedy';
    else if (type === 'theater' || type === 'broadway_tickets_national') category = 'Theater';

    return {
      id: `sg-${event.id}`,
      name: event.title,
      venue: event.venue?.name ?? 'Unknown Venue',
      date,
      time: timePart ?? null,
      dateSortKey: dt,
      category,
      url: event.url,
      source: 'seatgeek',
    };
  } catch {
    return null;
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateEvents(events) {
  const seen = new Map();
  const sorted = [...events].sort((a, b) =>
    a.source === 'ticketmaster' ? -1 : b.source === 'ticketmaster' ? 1 : 0
  );
  return sorted.filter(event => {
    const key = `${normalizeStr(event.name)}-${event.date}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ─── HTML Generation ─────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEventCards(events) {
  const byDate = {};
  for (const event of events) {
    if (!byDate[event.date]) byDate[event.date] = {};
    if (!byDate[event.date][event.venue]) byDate[event.date][event.venue] = [];
    byDate[event.date][event.venue].push(event);
  }

  let html = '';
  for (const date of Object.keys(byDate).sort()) {
    html += `\n  <div class="date-section">`;
    html += `\n    <div class="date-header">${esc(formatDisplayDate(date))}</div>`;

    for (const venue of Object.keys(byDate[date]).sort()) {
      html += `\n    <div class="venue-name">${esc(venue)}</div>`;

      const venueEvents = byDate[date][venue].sort((a, b) =>
        (a.time ?? '23:59') < (b.time ?? '23:59') ? -1 : 1
      );

      for (const ev of venueEvents) {
        const timeStr = ev.time ? formatTime(ev.time) : 'TBA';
        html += `\n    <div class="event-card">`;
        html += `<a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.name)}</a>`;
        html += `<span class="event-time">${esc(timeStr)}</span>`;
        html += `</div>`;
      }
    }
    html += `\n  </div>`;
  }
  return html;
}

function generateHTML(allEvents, newEvents) {
  const now = new Date();
  const etTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);

  let newSection = '';
  if (newEvents.length > 0) {
    newSection = `
  <div class="new-section">
    <div class="new-section-header">
      <span class="new-badge">NEW</span>
      Added Since Yesterday &mdash; ${newEvents.length} event${newEvents.length !== 1 ? 's' : ''}
    </div>
    ${buildEventCards(newEvents)}
  </div>
  <div class="section-divider"></div>`;
  } else {
    newSection = `
  <div class="new-section">
    <div class="new-section-header">
      <span class="new-badge">NEW</span>
      Added Since Yesterday
    </div>
    <p class="no-new-events">No new events added since last update.</p>
  </div>
  <div class="section-divider"></div>`;
  }

  const allSection = allEvents.length > 0
    ? buildEventCards(allEvents)
    : '\n  <p class="no-events">No upcoming events found. Check back tomorrow.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cincinnati Metro Events</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #fff;
      color: #1a1a1a;
      padding: 24px 20px;
      max-width: 700px;
      margin: 0 auto;
    }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: #555; font-size: 0.9rem; margin-bottom: 28px; }
    .new-section { margin-bottom: 12px; }
    .new-section-header {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 1.1rem;
      font-weight: 700;
      color: #166534;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 14px;
    }
    .new-badge {
      background: #16a34a;
      color: #fff;
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      padding: 2px 7px;
      border-radius: 4px;
    }
    .no-new-events {
      color: #666;
      font-style: italic;
      font-size: 0.9rem;
      padding: 0 4px 16px;
    }
    .section-divider { border-top: 1px solid #e0e0e0; margin: 24px 0; }
    .all-section-header {
      font-size: 1.1rem;
      font-weight: 700;
      color: #555;
      margin-bottom: 20px;
    }
    .date-section { margin-bottom: 32px; }
    .date-header {
      font-size: 1.25rem;
      font-weight: 700;
      border-bottom: 2px solid #1a1a1a;
      padding-bottom: 6px;
      margin-bottom: 12px;
    }
    .venue-name {
      color: #0066cc;
      font-weight: 600;
      font-size: 0.95rem;
      margin: 14px 0 6px;
    }
    .event-card {
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .event-card a {
      text-decoration: none;
      color: #1a1a1a;
      font-size: 0.95rem;
      flex: 1;
      line-height: 1.4;
    }
    .event-card a:hover { color: #0066cc; }
    .event-time {
      color: #777;
      font-size: 0.85rem;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .no-events { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <h1>Cincinnati Metro Events</h1>
  <p class="subtitle">${allEvents.length} upcoming events &bull; Updated ${esc(etTime)} ET</p>

  ${newSection}

  <div class="all-section-header">All Upcoming Events</div>
  ${allSection}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Cincinnati Metro Events Fetch ===');

  const knownIds = loadKnownIds();
  const isFirstRun = knownIds === null;
  if (isFirstRun) console.log('First run — establishing baseline, no "new" events shown.');

  const [tmEvents, sgEvents] = await Promise.all([
    fetchTicketmaster(),
    fetchSeatGeek(),
  ]);

  const allEvents = [...tmEvents, ...sgEvents];
  const deduped = deduplicateEvents(allEvents);
  deduped.sort((a, b) => a.dateSortKey.localeCompare(b.dateSortKey));
  console.log(`\nTotal after dedup: ${deduped.length} events`);

  const newEvents = isFirstRun ? [] : deduped.filter(e => !knownIds.has(e.id));
  console.log(`New since yesterday: ${newEvents.length} events`);

  saveKnownIds(deduped);

  const html = generateHTML(deduped, newEvents);
  const outputPath = path.join(process.cwd(), 'index.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
