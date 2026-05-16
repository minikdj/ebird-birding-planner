// utils.js — utility functions for the eBird birding planner MCP server

// ---------------------------------------------------------------------------
// Wind direction sets
// ---------------------------------------------------------------------------

export const FAVORABLE_WINDS = new Set(['S', 'SW', 'SSW', 'SE', 'W']);
export const POOR_WINDS = new Set(['N', 'NW', 'NNW', 'NE']);

// ---------------------------------------------------------------------------
// Activity window constants
// ---------------------------------------------------------------------------

export const ACTIVITY_CUTOFF_BASE_MINUTES = 180; // 3 hours after sunrise
export const HEAT_THRESHOLD_F = 75;
export const HEAT_STEP_F = 5;
export const HEAT_PENALTY_MINUTES = 15;
export const EARLIEST_ARRIVAL_MINUTES = 15;

// ---------------------------------------------------------------------------
// computeActivityCutoff
// ---------------------------------------------------------------------------

/**
 * Compute the latest recommended birding time based on sunrise and temperature.
 * @param {Date} sunriseDateObj - Sunrise time as a Date object
 * @param {number|null} morningHighF - Forecasted morning high in °F
 * @returns {Date}
 */
export function computeActivityCutoff(sunriseDateObj, morningHighF) {
  let cutoffMs = sunriseDateObj.getTime() + ACTIVITY_CUTOFF_BASE_MINUTES * 60 * 1000;
  if (morningHighF != null && morningHighF > HEAT_THRESHOLD_F) {
    const steps = Math.floor((morningHighF - HEAT_THRESHOLD_F) / HEAT_STEP_F);
    cutoffMs -= steps * HEAT_PENALTY_MINUTES * 60 * 1000;
  }
  const floorMs = sunriseDateObj.getTime() + EARLIEST_ARRIVAL_MINUTES * 60 * 1000;
  return new Date(Math.max(cutoffMs, floorMs));
}

// ---------------------------------------------------------------------------
// haversineKm (exported)
// ---------------------------------------------------------------------------

/**
 * Calculate the great-circle distance between two points in kilometers.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// weekIndexForDate
// ---------------------------------------------------------------------------

/**
 * Return a 0-based week-of-year index for a YYYY-MM-DD string (treated as noon UTC).
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {number}
 */
export function weekIndexForDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.ceil((d - start) / 86400000) + 1;
  return Math.floor((dayOfYear - 1) / 7);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export class Cache {
  constructor() {
    this._store = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  clear() {
    this._store.clear();
  }
}

// ---------------------------------------------------------------------------
// resolveLocation
// ---------------------------------------------------------------------------

const COUNTY_LOOKUP = {
  "US-OH-061": { lat: 39.1,  lng: -84.5,  name: "Hamilton County, OH" },
  "US-OH-049": { lat: 39.96, lng: -82.99, name: "Franklin County, OH" },
  "US-OH-113": { lat: 39.76, lng: -84.19, name: "Montgomery County, OH" },
  "US-OH-035": { lat: 41.50, lng: -81.69, name: "Cuyahoga County, OH" },
};

const CITY_LOOKUP = {
  "cincinnati":    { lat: 39.1,  lng: -84.5,   regionCode: "US-OH-061", name: "Cincinnati, OH" },
  "cincy":         { lat: 39.1,  lng: -84.5,   regionCode: "US-OH-061", name: "Cincinnati, OH" },
  "columbus":      { lat: 39.96, lng: -82.99,  regionCode: "US-OH-049", name: "Columbus, OH" },
  "dayton":        { lat: 39.76, lng: -84.19,  regionCode: "US-OH-113", name: "Dayton, OH" },
  "cleveland":     { lat: 41.50, lng: -81.69,  regionCode: "US-OH-035", name: "Cleveland, OH" },
  "asheville":     { lat: 35.60, lng: -82.55,  regionCode: "US-NC-021", name: "Asheville, NC" },
  "new york":      { lat: 40.78, lng: -73.97,  regionCode: "US-NY-061", name: "New York, NY" },
  "nyc":           { lat: 40.78, lng: -73.97,  regionCode: "US-NY-061", name: "New York, NY" },
  "chicago":       { lat: 41.88, lng: -87.63,  regionCode: "US-IL-031", name: "Chicago, IL" },
  "san francisco": { lat: 37.77, lng: -122.42, regionCode: "US-CA-075", name: "San Francisco, CA" },
  "sf":            { lat: 37.77, lng: -122.42, regionCode: "US-CA-075", name: "San Francisco, CA" },
  "austin":        { lat: 30.27, lng: -97.74,  regionCode: "US-TX-453", name: "Austin, TX" },
  "portland":      { lat: 45.52, lng: -122.68, regionCode: "US-OR-051", name: "Portland, OR" },
  "cape may":      { lat: 38.94, lng: -74.92,  regionCode: "US-NJ-009", name: "Cape May, NJ" },
  "cape may nj":   { lat: 38.94, lng: -74.92,  regionCode: "US-NJ-009", name: "Cape May, NJ" },
  "acadia":        { lat: 44.35, lng: -68.22,  regionCode: "US-ME-009", name: "Acadia, ME" },
  "acadia maine":  { lat: 44.35, lng: -68.22,  regionCode: "US-ME-009", name: "Acadia, ME" },
  "bar harbor":    { lat: 44.39, lng: -68.20,  regionCode: "US-ME-009", name: "Bar Harbor, ME" },
  "point reyes":   { lat: 38.07, lng: -122.85, regionCode: "US-CA-041", name: "Point Reyes, CA" },
  "monterey":      { lat: 36.60, lng: -121.89, regionCode: "US-CA-053", name: "Monterey, CA" },
  "orlando":       { lat: 28.54, lng: -81.38,  regionCode: "US-FL-095", name: "Orlando, FL" },
  "miami":         { lat: 25.77, lng: -80.19,  regionCode: "US-FL-086", name: "Miami, FL" },
  "everglades":    { lat: 25.39, lng: -80.58,  regionCode: "US-FL-086", name: "Everglades, FL" },
  "galveston":     { lat: 29.30, lng: -94.80,  regionCode: "US-TX-167", name: "Galveston, TX" },
  "high island":   { lat: 29.57, lng: -94.39,  regionCode: "US-TX-201", name: "High Island, TX" },
  "seattle":       { lat: 47.61, lng: -122.33, regionCode: "US-WA-033", name: "Seattle, WA" },
  "denver":        { lat: 39.74, lng: -104.98, regionCode: "US-CO-031", name: "Denver, CO" },
  "boulder":       { lat: 40.02, lng: -105.28, regionCode: "US-CO-013", name: "Boulder, CO" },
  "tucson":        { lat: 32.22, lng: -110.97, regionCode: "US-AZ-019", name: "Tucson, AZ" },
  "phoenix":       { lat: 33.45, lng: -112.07, regionCode: "US-AZ-013", name: "Phoenix, AZ" },
  "bosque del apache": { lat: 33.78, lng: -106.90, regionCode: "US-NM-003", name: "Bosque del Apache, NM" },
};

// Matches region codes: US-OH, US-OH-061, US-NC-021, etc.
const REGION_CODE_RE = /^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i;

// Matches "39.1,-84.5" or "39.1, -84.5"
const LAT_LNG_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

export function resolveLocation(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();

  // --- Lat/lng pair ---
  const latLngMatch = trimmed.match(LAT_LNG_RE);
  if (latLngMatch) {
    return {
      lat: parseFloat(latLngMatch[1]),
      lng: parseFloat(latLngMatch[2]),
      regionCode: null,
      name: trimmed,
    };
  }

  // --- Region code ---
  if (REGION_CODE_RE.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    const county = COUNTY_LOOKUP[upper];
    if (county) {
      return { lat: county.lat, lng: county.lng, regionCode: upper, name: county.name };
    }
    // State-level or unknown county — lat/lng unavailable
    return { lat: null, lng: null, regionCode: upper, name: upper };
  }

  // --- City name lookup ---
  const key = trimmed.toLowerCase();
  if (CITY_LOOKUP[key]) {
    return { ...CITY_LOOKUP[key] };
  }

  // No match
  return null;
}

// ---------------------------------------------------------------------------
// resolveDate helpers
// ---------------------------------------------------------------------------

export function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAY_NAMES  = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_MON_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MON_NAMES  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function humanLabel(d) {
  const dayName = SHORT_DAY_NAMES[d.getDay()];
  const monName = SHORT_MON_NAMES[d.getMonth()];
  return `${dayName} ${monName} ${d.getDate()}`;
}

/** Returns a new Date offset by +days from base (time zeroed in local). */
function offsetDay(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Returns the next occurrence of weekdayIndex (0=Sun…6=Sat) on or after base. */
function nextWeekday(base, weekdayIndex) {
  const d = new Date(base);
  const diff = (weekdayIndex - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 0 : diff));
  return d;
}

/** Returns the NEXT (strictly future) occurrence of weekdayIndex after base. */
function strictlyNextWeekday(base, weekdayIndex) {
  const d = new Date(base);
  const diff = (weekdayIndex - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

const MONTH_RE = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i;

function parseMonthDay(str) {
  const m = str.trim().match(MONTH_RE);
  if (!m) return null;
  const monStr = m[1].toLowerCase().slice(0, 3);
  const monIdx = SHORT_MON_NAMES.findIndex(n => n.toLowerCase() === monStr);
  if (monIdx < 0) return null;
  const day  = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  return new Date(year, monIdx, day);
}

// ---------------------------------------------------------------------------
// resolveDate
// ---------------------------------------------------------------------------

export function resolveDate(input) {
  if (!input || typeof input !== "string") return null;
  const lower = input.trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dateObj;
  let label;

  if (lower === "today") {
    dateObj = today;
    label = `today (${humanLabel(today)})`;
  } else if (lower === "tomorrow") {
    dateObj = offsetDay(today, 1);
    label = `tomorrow (${humanLabel(dateObj)})`;
  } else if (lower === "yesterday") {
    dateObj = offsetDay(today, -1);
    label = `yesterday (${humanLabel(dateObj)})`;
  } else if (lower === "this weekend") {
    // Note: resolveDate("this weekend") returns Saturday only (single trip day).
    // resolveDateRange("this weekend") returns Sat-Sun (the full weekend window).
    // This asymmetry is intentional — date context wants one day, range context wants both.
    dateObj = nextWeekday(today, 6);
    label = `this Saturday (${humanLabel(dateObj)})`;
  } else if (lower === "this week") {
    dateObj = today;
    label = `this week (starting ${humanLabel(today)})`;
  } else if (/^next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.test(lower)) {
    const dayName = lower.replace("next ", "");
    const dayIdx  = LONG_DAY_NAMES.findIndex(d => d.toLowerCase() === dayName);
    dateObj = strictlyNextWeekday(today, dayIdx);
    label   = `next ${LONG_DAY_NAMES[dayIdx]} (${humanLabel(dateObj)})`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
    // ISO date
    const [y, mo, d] = lower.split("-").map(Number);
    dateObj = new Date(y, mo - 1, d);
    label   = humanLabel(dateObj);
  } else {
    // "May 15" / "May 15, 2026"
    const parsed = parseMonthDay(lower);
    if (!parsed) return null;
    dateObj = parsed;
    label   = humanLabel(dateObj);
  }

  return { date: toYMD(dateObj), dateObj, label };
}

// ---------------------------------------------------------------------------
// resolveDateRange
// ---------------------------------------------------------------------------

const RANGE_EXPLICIT_RE = /^([a-z]+ \d{1,2})\s*[-–]\s*([a-z]+ \d{1,2}|\d{1,2})(?:,?\s*(\d{4}))?$/i;
const NEXT_N_DAYS_RE    = /^next\s+(\d+)\s+days?$/i;

export function resolveDateRange(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  const lower   = trimmed.toLowerCase();
  const today   = new Date();
  today.setHours(0, 0, 0, 0);

  // "this week" — Mon through Sun of current week
  if (lower === "this week") {
    const dayOfWeek = today.getDay(); // 0=Sun
    const monday    = offsetDay(today, -(dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const sunday    = offsetDay(monday, 6);
    return {
      start: toYMD(monday),
      end:   toYMD(sunday),
      label: `this week (${humanLabel(monday)} – ${humanLabel(sunday)})`,
    };
  }

  // "this weekend"
  if (lower === "this weekend") {
    const saturday = nextWeekday(today, 6);
    const sunday   = offsetDay(saturday, 1);
    return {
      start: toYMD(saturday),
      end:   toYMD(sunday),
      label: `this weekend (${humanLabel(saturday)} – ${humanLabel(sunday)})`,
    };
  }

  // "next 5 days" / "next 3 days"
  const nextNMatch = trimmed.match(NEXT_N_DAYS_RE);
  if (nextNMatch) {
    const n   = parseInt(nextNMatch[1], 10);
    const end = offsetDay(today, n - 1);
    return {
      start: toYMD(today),
      end:   toYMD(end),
      label: `next ${n} days (${humanLabel(today)} – ${humanLabel(end)})`,
    };
  }

  // "May 15-22" or "May 15 - May 22" or "May 15 - 22"
  const rangeMatch = trimmed.match(RANGE_EXPLICIT_RE);
  if (rangeMatch) {
    const year     = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : today.getFullYear();
    const startObj = parseMonthDay(`${rangeMatch[1]}, ${year}`);
    // End might be "May 22" or just "22" (same month as start)
    let endStr = rangeMatch[2];
    if (/^\d{1,2}$/.test(endStr.trim()) && startObj) {
      const startMon = LONG_MON_NAMES[startObj.getMonth()];
      endStr = `${startMon} ${endStr.trim()}, ${year}`;
    } else {
      endStr = `${endStr.trim()}, ${year}`;
    }
    const endObj = parseMonthDay(endStr);
    if (!startObj || !endObj) return null;
    return {
      start: toYMD(startObj),
      end:   toYMD(endObj),
      label: `${humanLabel(startObj)} – ${humanLabel(endObj)}`,
    };
  }

  // Fall back to resolveDate for single-day expressions
  const single = resolveDate(trimmed);
  if (single) {
    return { start: single.date, end: single.date, label: single.label };
  }

  return null;
}

// ---------------------------------------------------------------------------
// FAVORITE_HOTSPOTS
// ---------------------------------------------------------------------------

export const FAVORITE_HOTSPOTS = [
  { name: "Mount Airy Forest",  locId: null },
  { name: "Shawnee Lookout",    locId: null },
  { name: "Otto Armleder",      locId: null },
  { name: "Middle Creek Park",  locId: null },
  { name: "Sharon Woods",       locId: null },
];

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  regionCode: "US-OH-061",
  lat:        39.1,
  lng:        -84.5,
  radiusKm:   30,
  name:       "Cincinnati, OH (Hamilton County)",
};

// ---------------------------------------------------------------------------
// getFavoriteHotspots
// ---------------------------------------------------------------------------

/**
 * Returns the user's favorite hotspots.
 * If BRIEFING_FAVORITE_HOTSPOTS is set (comma-separated eBird locIds), those are used.
 * Otherwise falls back to the FAVORITE_HOTSPOTS default list.
 * @returns {{ locId: string|null, name?: string }[]}
 */
export function getFavoriteHotspots() {
  const envVal = (process.env.BRIEFING_FAVORITE_HOTSPOTS || '').trim();
  if (envVal) {
    return envVal.split(',').map((id) => ({ locId: id.trim() })).filter((h) => h.locId);
  }
  return FAVORITE_HOTSPOTS;
}

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

export function formatNumber(n) {
  if (n == null) return "N/A";
  return Number(n).toLocaleString("en-US");
}
