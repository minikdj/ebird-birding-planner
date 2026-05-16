const BASE_URL = 'https://api.ebird.org/v2';
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export class EBirdClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.requestTimestamps = [];
  }

  async #enforceRateLimit() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS
    );

    if (this.requestTimestamps.length >= RATE_LIMIT_MAX) {
      const oldest = this.requestTimestamps[0];
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.requestTimestamps = this.requestTimestamps.filter(
        (ts) => Date.now() - ts < RATE_LIMIT_WINDOW_MS
      );
    }

    this.requestTimestamps.push(Date.now());
  }

  async makeRequest(endpoint, params = {}) {
    await this.#enforceRateLimit();

    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        'X-eBirdApiToken': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `eBird API error ${response.status} for ${endpoint}: ${response.statusText}`
      );
    }

    return response.json();
  }

  getNearbyHotspots(lat, lng, dist = 30) {
    return this.makeRequest('/ref/hotspot/geo', { lat, lng, dist, fmt: 'json' });
  }

  getHotspotInfo(locId) {
    return this.makeRequest(`/ref/hotspot/info/${locId}`);
  }

  getRecentObservations(locId, back = 7) {
    return this.makeRequest(`/data/obs/${locId}/recent`, { back });
  }

  getRecentObservationsInRegion(regionCode, back = 7) {
    return this.makeRequest(`/data/obs/${regionCode}/recent`, { back });
  }

  getNearbyNotableObservations(lat, lng, back = 14, dist = 50) {
    return this.makeRequest('/data/obs/geo/recent/notable', { lat, lng, back, dist });
  }

  getRegionNotableObservations(regionCode, back = 14) {
    return this.makeRequest(`/data/obs/${regionCode}/recent/notable`, { back });
  }

  getNearbySpeciesObservations(lat, lng, speciesCode, back = 14, dist = 50) {
    return this.makeRequest(`/data/obs/geo/recent/${speciesCode}`, { lat, lng, back, dist });
  }

  getChecklistsOnDate(regionCode, y, m, d) {
    return this.makeRequest(`/product/lists/${regionCode}/${y}/${m}/${d}`);
  }

  getRegionStats(regionCode, y, m, d) {
    return this.makeRequest(`/product/stats/${regionCode}/${y}/${m}/${d}`);
  }

  getTaxonomy() {
    return this.makeRequest('/ref/taxonomy/ebird', { fmt: 'json', cat: 'species' });
  }

  getSpeciesList(regionCode) {
    return this.makeRequest(`/product/spplist/${regionCode}`);
  }

  searchHotspotsByRegion(regionCode) {
    return this.makeRequest(`/ref/hotspot/${regionCode}`, { fmt: 'json' });
  }
}
