/**
 * BirdCast Migration Data Client
 *
 * Provides access to BirdCast's migration intensity and species data.
 * BirdCast is only active during migration seasons:
 *   - Spring: March 1 - June 15
 *   - Fall:   August 1 - November 15
 *
 * Outside those windows all data methods return null gracefully.
 */

import { fetchWithRetry } from './utils.js';

const USER_AGENT = 'ebird-birding-planner/1.0 (https://github.com/minikdj/ebird-birding-planner)';

export class BirdCastClient {
  static BASE_URL = 'https://dashboard.birdcast.org/api/v1';

  constructor(apiKey) {
    this.apiKey = apiKey;
    this._lastBirdCastCall = 0;
    this._birdcastQueue = Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Season guard
  // -------------------------------------------------------------------------

  /**
   * Returns true if the given date falls within a BirdCast migration season.
   * @param {Date|string} date - Date object or YYYY-MM-DD string
   * @returns {boolean}
   */
  isInMigrationSeason(date) {
    const d = typeof date === 'string' ? new Date(date + 'T12:00:00Z') : date;
    const month = d.getUTCMonth() + 1; // 1-12
    const day = d.getUTCDate();

    // Spring: March 1 (3/1) through June 15 (6/15)
    const inSpring =
      (month === 3) ||
      (month === 4) ||
      (month === 5) ||
      (month === 6 && day <= 15);

    // Fall: August 1 (8/1) through November 15 (11/15)
    const inFall =
      (month === 8) ||
      (month === 9) ||
      (month === 10) ||
      (month === 11 && day <= 15);

    return inSpring || inFall;
  }

  // -------------------------------------------------------------------------
  // Internal fetch helper
  // -------------------------------------------------------------------------

  /**
   * Performs a GET request and returns parsed JSON, or null on any error.
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async #get(url) {
    this._birdcastQueue = this._birdcastQueue.then(() => this.#doGet(url));
    return this._birdcastQueue;
  }

  async #doGet(url) {
    try {
      const elapsed = Date.now() - this._lastBirdCastCall;
      if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed));
      this._lastBirdCastCall = Date.now();
      const headers = { 'User-Agent': USER_AGENT };
      const response = await fetchWithRetry(url, { headers, signal: AbortSignal.timeout(10_000) }, { retries: 1, baseMs: 500, label: 'birdcast:request' });
      if (!response.ok) {
        const safeUrl = url.replace(/([?&]key=)[^&]+/, '$1***');
        process.stderr.write(
          `BirdCastClient: HTTP ${response.status} for ${safeUrl}\n`
        );
        return null;
      }
      return await response.json();
    } catch (err) {
      const safeUrl = url.replace(/([?&]key=)[^&]+/, '$1***');
      process.stderr.write(`BirdCastClient: fetch error for ${safeUrl}: ${err.message}\n`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Migration data endpoints
  // -------------------------------------------------------------------------

  /**
   * Live migration data — birds in flight, direction, speed, altitude for the
   * given night (10-minute intervals via nightSeries).
   *
   * @param {string} regionCode - BirdCast region code (e.g. "US-OH-061")
   * @param {string} date       - YYYY-MM-DD
   * @returns {Promise<object|null>}
   */
  async getLiveMigration(regionCode, date) {
    if (!this.isInMigrationSeason(date)) {
      process.stderr.write(
        `BirdCastClient: getLiveMigration called outside migration season (${date})\n`
      );
      return null;
    }

    const params = new URLSearchParams({ key: this.apiKey, applyThreshold: 'true' });
    const url =
      `${BirdCastClient.BASE_URL}/is-birdcast-alert-api/livemigration` +
      `/${encodeURIComponent(regionCode)}/${date}` +
      `?${params}`;

    return this.#get(url);
  }

  /**
   * Season historical data — cumulative totals and multi-year averages.
   *
   * @param {string} regionCode - BirdCast region code
   * @param {string} date       - YYYY-MM-DD
   * @returns {Promise<object|null>}
   */
  async getSeasonHistorical(regionCode, date) {
    if (!this.isInMigrationSeason(date)) {
      process.stderr.write(
        `BirdCastClient: getSeasonHistorical called outside migration season (${date})\n`
      );
      return null;
    }

    const params = new URLSearchParams({ key: this.apiKey });
    const url =
      `${BirdCastClient.BASE_URL}/is-birdcast-alert-api/seasonhistorical` +
      `/${encodeURIComponent(regionCode)}/${date}` +
      `?${params}`;

    return this.#get(url);
  }

  /**
   * Expected species for the region, sorted by the probability for the week
   * that contains the given date (descending).
   *
   * The BirdCast bar chart has 48 weekly buckets where bucket 0 = first week
   * of January and bucket 47 = last week of December. We calculate the
   * week-of-year index (0-based) and clamp it to [0, 47].
   *
   * @param {string} regionCode - BirdCast region code
   * @param {string} date       - YYYY-MM-DD
   * @returns {Promise<Array<{commonName, sciName, speciesCode, probability}>|null>}
   */
  async getExpectedSpecies(regionCode, date, { ignoreSeasonCheck = false } = {}) {
    if (!ignoreSeasonCheck && !this.isInMigrationSeason(date)) {
      process.stderr.write(
        `BirdCastClient: getExpectedSpecies called outside migration season (${date})\n`
      );
      return null;
    }

    const params = new URLSearchParams({ key: this.apiKey });
    const url =
      `${BirdCastClient.BASE_URL}/is-birdcast-alert-api/barchart` +
      `/${encodeURIComponent(regionCode)}/${date}` +
      `?${params}`;

    const data = await this.#get(url);
    if (!data || !Array.isArray(data.dataRows)) {
      return null;
    }

    // Determine which weekly bucket corresponds to the date.
    // Week index = floor(dayOfYear / 7), clamped to [0, 47].
    const d = new Date(date + 'T12:00:00Z');
    const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const dayOfYear = Math.floor((d - startOfYear) / (1000 * 60 * 60 * 24)); // 0-based
    const weekIndex = Math.min(Math.floor(dayOfYear / 7), 47);

    const species = data.dataRows
      .map((row) => ({
        commonName: row.taxon?.commonName ?? null,
        sciName: row.taxon?.sciName ?? null,
        speciesCode: row.taxon?.speciesCode ?? null,
        probability: Array.isArray(row.values) ? (row.values[weekIndex] ?? 0) : 0,
      }))
      .filter((s) => s.commonName !== null)
      .sort((a, b) => b.probability - a.probability);

    return species;
  }

  // -------------------------------------------------------------------------
  // Region lookup endpoints
  // -------------------------------------------------------------------------

  /**
   * Look up metadata for a known region code.
   *
   * @param {string} regionCode
   * @returns {Promise<{name: string}|null>}
   */
  async getRegionInfo(regionCode) {
    const url =
      `${BirdCastClient.BASE_URL}/region/info` +
      `?regionCode=${encodeURIComponent(regionCode)}`;

    const data = await this.#get(url);
    if (!data) return null;

    return { name: data.name ?? regionCode };
  }

  /**
   * Search for regions matching a free-text query.
   *
   * @param {string} query
   * @returns {Promise<Array<{code, name, timezone}>>}
   */
  async findRegion(query) {
    const url =
      `${BirdCastClient.BASE_URL}/region/find` +
      `?q=${encodeURIComponent(query)}`;

    const data = await this.#get(url);
    if (!Array.isArray(data)) return [];

    return data.map((r) => ({
      code: r.code ?? null,
      name: r.name ?? null,
      timezone: r.timezone ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Plain-English summary
  // -------------------------------------------------------------------------

  /**
   * Produces a plain-English migration summary from live + historical data.
   *
   * @param {object|null} liveMigrationData  - Response from getLiveMigration()
   * @param {object|null} seasonData         - Response from getSeasonHistorical()
   * @returns {string}
   */
  summarizeMigration(liveMigrationData, seasonData) {
    const parts = [];

    // --- Live migration summary ---
    if (liveMigrationData) {
      const birds = liveMigrationData.cumulativeBirds;
      const isHigh = liveMigrationData.isHigh;
      const season = liveMigrationData.season?.name ?? '';

      if (birds != null) {
        const formatted = _formatCount(birds);
        const intensity = isHigh ? 'high intensity' : 'moderate intensity';
        parts.push(`${formatted} birds crossed the region last night (${intensity}).`);
      }

      // Summarise overnight flight characteristics from nightSeries
      const series = liveMigrationData.nightSeries;
      if (Array.isArray(series) && series.length > 0) {
        const peakInterval = series.reduce(
          (best, cur) => (cur.numAloft > (best?.numAloft ?? -1) ? cur : best),
          null
        );
        if (peakInterval?.numAloft) {
          const dir = degreesToCardinal(peakInterval.avgDirection);
          const speed = peakInterval.avgSpeed != null
            ? ` at ${Math.round(peakInterval.avgSpeed)} mph`
            : '';
          const alt = peakInterval.meanHeight != null
            ? `, mean altitude ${Math.round(peakInterval.meanHeight)} m`
            : '';
          parts.push(
            `Peak flight was heading ${dir}${speed}${alt}.`
          );
        }
      }

      if (season) {
        parts.push(`Current season: ${season}.`);
      }
    } else {
      parts.push('No live migration data available for last night.');
    }

    // --- Season historical summary ---
    if (seasonData) {
      const currentSeries = seasonData.season?.currentSeasonSeries;
      const avgSeries = seasonData.season?.annualAvgSeries;

      if (Array.isArray(currentSeries) && currentSeries.length > 0) {
        const latestCurrent = currentSeries[currentSeries.length - 1];
        const currentTotal = latestCurrent?.totalBirds ?? latestCurrent?.value ?? (typeof latestCurrent === 'number' ? latestCurrent : null);

        if (currentTotal != null) {
          const formattedCurrent = _formatCount(currentTotal);

          if (Array.isArray(avgSeries) && avgSeries.length > 0) {
            const latestAvg = avgSeries[avgSeries.length - 1];
            const avgTotal = latestAvg?.totalBirds ?? latestAvg?.value ?? (typeof latestAvg === 'number' ? latestAvg : null);

            if (avgTotal != null) {
              const formattedAvg = _formatCount(avgTotal);
              const pct = Math.round(((currentTotal - avgTotal) / avgTotal) * 100);
              const trend = pct > 0
                ? `above average by ${Math.abs(pct)}%`
                : pct < 0
                ? `below average by ${Math.abs(pct)}%`
                : 'on par with the historical average';

              parts.push(
                `Season total is ${formattedCurrent} vs ${formattedAvg} historical average — ${trend} at this point in the season.`
              );
            } else {
              parts.push(`Season cumulative total: ${formattedCurrent}.`);
            }
          } else {
            parts.push(`Season cumulative total: ${formattedCurrent}.`);
          }
        }
      }

      // Describe weekly trend from rolling average
      const weeklySeries = seasonData.nightWeeklyAvgSeries;
      if (Array.isArray(weeklySeries) && weeklySeries.length >= 2) {
        const last = weeklySeries[weeklySeries.length - 1]?.numAloft
          ?? weeklySeries[weeklySeries.length - 1]?.value
          ?? (typeof weeklySeries[weeklySeries.length - 1] === 'number' ? weeklySeries[weeklySeries.length - 1] : null);
        const prev = weeklySeries[weeklySeries.length - 2]?.numAloft
          ?? weeklySeries[weeklySeries.length - 2]?.value
          ?? (typeof weeklySeries[weeklySeries.length - 2] === 'number' ? weeklySeries[weeklySeries.length - 2] : null);

        if (last != null && prev != null) {
          const direction = last > prev ? 'building' : last < prev ? 'declining' : 'steady';
          parts.push(`7-day rolling average is ${direction}.`);
        }
      }
    }

    return parts.join(' ');
  }
}

// ---------------------------------------------------------------------------
// Internal utilities (not exported)
// ---------------------------------------------------------------------------

/**
 * Format a large bird count as a human-readable string (e.g. "1.4M", "388,000").
 * @param {number} n
 * @returns {string}
 */
function _formatCount(n) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return n.toLocaleString('en-US');
  }
  return String(n);
}

/**
 * Convert a compass bearing (degrees) to an 8-point cardinal direction string.
 * @param {number|null} degrees
 * @returns {string}
 */
export function degreesToCardinal(degrees) {
  if (degrees == null) return 'unknown direction';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(degrees / 45) % 8;
  return dirs[(index + 8) % 8];
}

