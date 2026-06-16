// /api/_lib/holidays.js
// ─────────────────────────────────────────────────────────────────────────────
// [HOLIDAY-PICKER] US observance catalog for the Plan tab's holiday picker.
// Returns observances whose date or month-range overlaps with a given
// generation window so the picker can show "what's happening" without
// users having to remember.
//
// Design choices (per the product alignment with Lauren):
//   - Default state in the UI is ALL OFF. No app-side relevance scoring
//     or auto-selection. The picker surfaces neutral information; the
//     user decides what to weave into their plan.
//   - Catalog sorted chronologically (date order). No "importance"
//     ranking — that would re-introduce the bias the picker is meant to
//     avoid.
//   - Federal holidays, major cultural / retail moments, and heritage
//     month observances all included as peers. The category field is
//     for UI grouping ("this week" vs. "ongoing month") only — it does
//     NOT imply importance.
//
// Known scope limitations (intentional v1 — worth revisiting):
//   - Christian-calendar holidays that ARE federal (Christmas) are
//     included. Non-Christian religious observances (Hanukkah, Eid,
//     Diwali, Yom Kippur, Passover, Lunar New Year) are NOT — they
//     require lunar/Hebrew/Islamic calendar logic that's out of v1
//     scope. Adding them is a clear follow-up if the picker becomes
//     a feature creators rely on year-round.
//   - Easter is similarly skipped (requires computus algorithm).
//
// Date resolution:
//   - 'fixed':  { month, day }                          → fixed date each year
//   - 'nth':    { month, nth, weekday[, offset] }       → nth weekday of month
//                                                        offset shifts N days
//                                                        (e.g. Black Friday =
//                                                        Thanksgiving + 1)
//   - 'last':   { month, weekday }                      → last weekday of month
//   - 'range':  { startMonth, startDay?, endMonth, endDay? } → month-spanning
// ─────────────────────────────────────────────────────────────────────────────

const OBSERVANCES = [
  // ── January ────────────────────────────────────────────────────────────
  { id: "new-years-day",    name: "New Year's Day",      category: "federal",  fixed: { month: 1, day: 1 } },
  { id: "mlk-day",          name: "MLK Day",             category: "federal",  nth:   { month: 1, nth: 3, weekday: 1 } },
  // ── February ───────────────────────────────────────────────────────────
  { id: "black-history-month", name: "Black History Month", category: "heritage", range: { startMonth: 2, endMonth: 2 } },
  { id: "valentines-day",   name: "Valentine's Day",     category: "cultural", fixed: { month: 2, day: 14 } },
  { id: "presidents-day",   name: "Presidents Day",      category: "federal",  nth:   { month: 2, nth: 3, weekday: 1 } },
  // ── March ──────────────────────────────────────────────────────────────
  { id: "womens-history-month", name: "Women's History Month", category: "heritage", range: { startMonth: 3, endMonth: 3 } },
  { id: "st-patricks-day",  name: "St. Patrick's Day",   category: "cultural", fixed: { month: 3, day: 17 } },
  // ── May ────────────────────────────────────────────────────────────────
  { id: "aapi-heritage-month", name: "AAPI Heritage Month", category: "heritage", range: { startMonth: 5, endMonth: 5 } },
  { id: "mental-health-month", name: "Mental Health Awareness Month", category: "awareness", range: { startMonth: 5, endMonth: 5 } },
  { id: "mothers-day",      name: "Mother's Day",        category: "cultural", nth:   { month: 5, nth: 2, weekday: 0 } },
  { id: "memorial-day",     name: "Memorial Day",        category: "federal",  last:  { month: 5, weekday: 1 } },
  // ── June ───────────────────────────────────────────────────────────────
  { id: "pride-month",          name: "Pride Month",                category: "heritage", range: { startMonth: 6, endMonth: 6 } },
  { id: "black-music-month",    name: "Black Music Month",          category: "heritage", range: { startMonth: 6, endMonth: 6 } },
  { id: "caribbean-heritage",   name: "Caribbean American Heritage Month", category: "heritage", range: { startMonth: 6, endMonth: 6 } },
  { id: "fathers-day",      name: "Father's Day",        category: "cultural", nth:   { month: 6, nth: 3, weekday: 0 } },
  { id: "juneteenth",       name: "Juneteenth",          category: "federal",  fixed: { month: 6, day: 19 } },
  // ── July ───────────────────────────────────────────────────────────────
  { id: "independence-day", name: "Independence Day",    category: "federal",  fixed: { month: 7, day: 4 } },
  // ── September ──────────────────────────────────────────────────────────
  { id: "hispanic-heritage-month", name: "Hispanic Heritage Month", category: "heritage", range: { startMonth: 9, startDay: 15, endMonth: 10, endDay: 15 } },
  { id: "labor-day",        name: "Labor Day",           category: "federal",  nth:   { month: 9, nth: 1, weekday: 1 } },
  // ── October ────────────────────────────────────────────────────────────
  { id: "lgbtq-history-month", name: "LGBTQ+ History Month", category: "heritage", range: { startMonth: 10, endMonth: 10 } },
  { id: "columbus-indigenous", name: "Columbus Day / Indigenous Peoples' Day", category: "federal", nth: { month: 10, nth: 2, weekday: 1 } },
  { id: "halloween",        name: "Halloween",           category: "cultural", fixed: { month: 10, day: 31 } },
  // ── November ───────────────────────────────────────────────────────────
  { id: "native-american-month", name: "Native American Heritage Month", category: "heritage", range: { startMonth: 11, endMonth: 11 } },
  { id: "veterans-day",     name: "Veterans Day",        category: "federal",  fixed: { month: 11, day: 11 } },
  { id: "thanksgiving",     name: "Thanksgiving",        category: "federal",  nth:   { month: 11, nth: 4, weekday: 4 } },
  { id: "black-friday",     name: "Black Friday",        category: "retail",   nth:   { month: 11, nth: 4, weekday: 4, offset: 1 } },
  { id: "small-biz-sat",    name: "Small Business Saturday", category: "retail", nth: { month: 11, nth: 4, weekday: 4, offset: 2 } },
  { id: "cyber-monday",     name: "Cyber Monday",        category: "retail",   nth:   { month: 11, nth: 4, weekday: 4, offset: 4 } },
  // ── December ───────────────────────────────────────────────────────────
  { id: "christmas",        name: "Christmas Day",       category: "federal",  fixed: { month: 12, day: 25 } },
  { id: "new-years-eve",    name: "New Year's Eve",      category: "cultural", fixed: { month: 12, day: 31 } },
];

const WEEKDAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// Resolve an observance to a Date for the given year. Returns null when
// the entry has no single resolvable date (month-long ranges).
function resolveDate(entry, year) {
  if (entry.fixed) {
    return new Date(Date.UTC(year, entry.fixed.month - 1, entry.fixed.day));
  }
  if (entry.nth) {
    const cfg = entry.nth;
    // First day of the target month, 00:00 UTC.
    const first = new Date(Date.UTC(year, cfg.month - 1, 1));
    const firstWeekday = first.getUTCDay();
    // Offset from day-1 to the nth occurrence of cfg.weekday.
    let daysUntilTarget = (cfg.weekday - firstWeekday + 7) % 7;
    daysUntilTarget += (cfg.nth - 1) * 7;
    const base = new Date(Date.UTC(year, cfg.month - 1, 1 + daysUntilTarget));
    if (cfg.offset) {
      base.setUTCDate(base.getUTCDate() + cfg.offset);
    }
    return base;
  }
  if (entry.last) {
    const cfg = entry.last;
    // Step back from the first day of the NEXT month to find the last cfg.weekday.
    const firstNext = new Date(Date.UTC(year, cfg.month, 1));
    const lastDay   = new Date(firstNext.getTime() - 86400000);
    const lastWd    = lastDay.getUTCDay();
    const backstep  = (lastWd - cfg.weekday + 7) % 7;
    return new Date(lastDay.getTime() - backstep * 86400000);
  }
  return null;
}

// Resolve a month-long range to {start, end} Date pair for the given year.
// Returns null when the entry isn't a range. End date is inclusive.
function resolveRange(entry, year) {
  if (!entry.range) return null;
  const r = entry.range;
  const startDay = r.startDay || 1;
  const start = new Date(Date.UTC(year, r.startMonth - 1, startDay));
  // End-of-month when endDay omitted.
  let end;
  if (r.endDay) {
    end = new Date(Date.UTC(year, r.endMonth - 1, r.endDay));
  } else {
    // First day of next month - 1 day.
    end = new Date(Date.UTC(year, r.endMonth, 1) - 86400000);
  }
  return { start, end };
}

function formatHumanDate(d) {
  const day = d.getUTCDate();
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  const weekday = WEEKDAY_NAMES[d.getUTCDay()];
  return weekday + ", " + month + " " + day;
}

// Returns the list of observances that overlap with the [from, from+dayRange]
// window. Each entry includes its UI-ready shape:
//   { id, name, category, kind: "single" | "ongoing", date | range, dateLabel }
// Sorted chronologically — single-day entries by date, ongoing entries
// appended after (since they apply for the whole window).
export function getUpcomingObservances(fromDate, dayRange) {
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());
  const range = Math.max(1, Math.min(60, parseInt(dayRange, 10) || 7));
  const to = new Date(from.getTime() + range * 86400000);
  const fromYear = from.getUTCFullYear();
  const toYear   = to.getUTCFullYear();

  const singleDay = [];
  const ongoing   = [];

  for (const entry of OBSERVANCES) {
    // Single-day observances: resolve for each candidate year the window
    // might touch (e.g. Dec 28 → Jan 4 spans two years).
    if (entry.fixed || entry.nth || entry.last) {
      for (let y = fromYear; y <= toYear; y++) {
        const d = resolveDate(entry, y);
        if (!d) continue;
        if (d.getTime() >= from.getTime() && d.getTime() <= to.getTime()) {
          singleDay.push({
            id:        entry.id,
            name:      entry.name,
            category:  entry.category,
            kind:      "single",
            date:      d.toISOString().slice(0, 10),
            dateLabel: formatHumanDate(d),
            ts:        d.getTime(),
          });
        }
      }
      continue;
    }
    // Month-spanning observances: include when ANY part of the range
    // overlaps the generation window.
    if (entry.range) {
      for (let y = fromYear; y <= toYear; y++) {
        const r = resolveRange(entry, y);
        if (!r) continue;
        if (r.end.getTime() < from.getTime() || r.start.getTime() > to.getTime()) continue;
        ongoing.push({
          id:        entry.id,
          name:      entry.name,
          category:  entry.category,
          kind:      "ongoing",
          range:     { start: r.start.toISOString().slice(0, 10), end: r.end.toISOString().slice(0, 10) },
          dateLabel: "ongoing through " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][r.end.getUTCMonth()] + " " + r.end.getUTCDate(),
          ts:        r.start.getTime(),
        });
      }
    }
  }

  singleDay.sort((a, b) => a.ts - b.ts);
  ongoing.sort((a, b)  => a.ts - b.ts);
  return { singleDay, ongoing };
}

// Render a selected-observances list as a prompt-ready string. Used by the
// plan builder when the user picks observances in the picker. Returns ""
// when the list is empty or no observance ids matched — caller can concat
// unconditionally.
//
// Args:
//   selectedIds  — array of observance id strings from the picker
//   fromDate     — same anchor date used for the plan generation, so the
//                   resolved dates here match what the picker showed.
//   dayRange     — same window length (typically 7).
export function formatObservancesForPrompt(selectedIds, fromDate, dayRange) {
  if (!Array.isArray(selectedIds) || !selectedIds.length) return "";
  const { singleDay, ongoing } = getUpcomingObservances(fromDate, dayRange);
  const wanted = new Set(selectedIds);
  const inWindow = [];
  for (const s of singleDay) if (wanted.has(s.id)) inWindow.push(s);
  for (const o of ongoing)   if (wanted.has(o.id)) inWindow.push(o);
  if (!inWindow.length) return "";

  const lines = inWindow.map(o => {
    if (o.kind === "single") return "  - " + o.name + " (" + o.dateLabel + ")";
    return "  - " + o.name + " (" + o.dateLabel + ")";
  });
  return "OBSERVANCES THE CREATOR WANTS TO ACKNOWLEDGE THIS WEEK:\n"
    + lines.join("\n")
    + "\n\nWeave these into the plan where the day + brand land naturally. Don't shoehorn a holiday into an off-brand card; if no card fits naturally, skip the observance entirely. For ongoing month-long observances, lean in on cards where the creator's niche has a genuine angle, not as a tag on every post.";
}
