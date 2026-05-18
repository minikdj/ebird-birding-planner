import { fetchWithRetry } from './utils.js';

const BASE_URL = 'https://api.ebird.org/v2';
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export class EBirdClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.requestTimestamps = [];
    this._rateLimitQueue = Promise.resolve();
  }

  #validateLocId(locId) {
    if (!/^L\d+$/.test(locId)) throw new Error(`Invalid location ID: ${locId}`);
  }
  #validateRegionCode(code) {
    if (!/^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(code)) throw new Error(`Invalid region code: ${code}`);
  }
  #validateDateParts(y, m, d) {
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error(`Invalid year: ${y}`);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error(`Invalid month: ${m}`);
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error(`Invalid day: ${d}`);
  }

  #enforceRateLimit() {
    this._rateLimitQueue = this._rateLimitQueue.then(() => new Promise(resolve => {
      const now = Date.now();
      // sliding window: keep only timestamps within the last minute
      this.requestTimestamps = (this.requestTimestamps || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
      if (this.requestTimestamps.length >= RATE_LIMIT_MAX) {
        const waitMs = RATE_LIMIT_WINDOW_MS - (now - this.requestTimestamps[0]) + 1;
        setTimeout(() => {
          this.requestTimestamps = this.requestTimestamps.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW_MS);
          this.requestTimestamps.push(Date.now());
          resolve();
        }, waitMs);
      } else {
        this.requestTimestamps.push(Date.now());
        resolve();
      }
    }));
    return this._rateLimitQueue;
  }

  async makeRequest(endpoint, params = {}) {
    await this.#enforceRateLimit();

    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetchWithRetry(url.toString(), {
      headers: {
        'X-eBirdApiToken': this.apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    }, { retries: 1, baseMs: 500, label: 'ebird:request' });

    if (!response.ok) {
      throw new Error(
        `eBird API error ${response.status} for ${endpoint}: ${response.statusText}`
      );
    }

    try {
      return await response.json();
    } catch (parseErr) {
      throw new Error(`eBird JSON parse error for ${endpoint}: ${parseErr.message}`);
    }
  }

  getNearbyHotspots(lat, lng, dist = 30) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) ||
        Number(lat) < -90 || Number(lat) > 90 || Number(lng) < -180 || Number(lng) > 180) {
      return Promise.resolve([]);
    }
    return this.makeRequest('/ref/hotspot/geo', { lat, lng, dist, fmt: 'json' });
  }

  getHotspotInfo(locId) {
    this.#validateLocId(locId);
    return this.makeRequest(`/ref/hotspot/info/${locId}`);
  }

  getRecentObservations(locId, back = 7) {
    this.#validateLocId(locId);
    return this.makeRequest(`/data/obs/${locId}/recent`, { back });
  }

  getRecentObservationsInRegion(regionCode, back = 7) {
    this.#validateRegionCode(regionCode);
    return this.makeRequest(`/data/obs/${regionCode}/recent`, { back });
  }

  getNearbyNotableObservations(lat, lng, back = 14, dist = 50) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) ||
        Number(lat) < -90 || Number(lat) > 90 || Number(lng) < -180 || Number(lng) > 180) {
      return Promise.resolve([]);
    }
    return this.makeRequest('/data/obs/geo/recent/notable', { lat, lng, back, dist });
  }

  getRegionNotableObservations(regionCode, back = 14) {
    this.#validateRegionCode(regionCode);
    return this.makeRequest(`/data/obs/${regionCode}/recent/notable`, { back });
  }

  getNearbySpeciesObservations(lat, lng, speciesCode, back = 14, dist = 50) {
    if (!/^[a-z0-9]{4,10}$/i.test(speciesCode)) throw new Error(`Invalid species code: ${speciesCode}`);
    return this.makeRequest(`/data/obs/geo/recent/${speciesCode}`, { lat, lng, back, dist });
  }

  getChecklistsOnDate(regionCode, y, m, d) {
    this.#validateRegionCode(regionCode);
    this.#validateDateParts(Number(y), Number(m), Number(d));
    return this.makeRequest(`/product/lists/${regionCode}/${y}/${m}/${d}`);
  }

  getRegionStats(regionCode, y, m, d) {
    this.#validateRegionCode(regionCode);
    this.#validateDateParts(Number(y), Number(m), Number(d));
    return this.makeRequest(`/product/stats/${regionCode}/${y}/${m}/${d}`);
  }

  getTaxonomy() {
    return this.makeRequest('/ref/taxonomy/ebird', { fmt: 'json', cat: 'species' });
  }

  getSpeciesList(regionCode) {
    this.#validateRegionCode(regionCode);
    return this.makeRequest(`/product/spplist/${regionCode}`);
  }

  searchHotspotsByRegion(regionCode) {
    this.#validateRegionCode(regionCode);
    return this.makeRequest(`/ref/hotspot/${regionCode}`, { fmt: 'json' });
  }
}
