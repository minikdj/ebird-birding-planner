import { Cache } from './utils.js';

const BASE_URL = 'https://api.inaturalist.org/v1';
const RATE_LIMIT_DELAY_MS = 1000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class INaturalistClient {
  constructor() {
    this.lastRequestTime = 0;
    this.cache = new Cache();
  }

  #validateInputs(speciesName, lat, lng, radiusKm, daysBack) {
    if (typeof speciesName !== 'string' || speciesName.trim().length === 0) {
      throw new Error('speciesName must be a non-empty string');
    }
    if (!Number.isFinite(lat)) {
      throw new Error('lat must be a finite number');
    }
    if (!Number.isFinite(lng)) {
      throw new Error('lng must be a finite number');
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 200) {
      throw new Error('radiusKm must be between 1 and 200');
    }
    if (!Number.isFinite(daysBack) || daysBack < 1 || daysBack > 30) {
      throw new Error('daysBack must be between 1 and 30');
    }
  }

  #getDateStrings(daysBack) {
    const today = new Date();
    const d2 = new Date(today);
    d2.setHours(23, 59, 59, 999);

    const d1 = new Date(today);
    d1.setDate(d1.getDate() - daysBack);
    d1.setHours(0, 0, 0, 0);

    const toYMD = (date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    return { d1: toYMD(d1), d2: toYMD(d2) };
  }

  async #enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < RATE_LIMIT_DELAY_MS) {
      const delay = RATE_LIMIT_DELAY_MS - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }

  async #get(url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        process.stderr.write(
          `INaturalistClient: HTTP ${response.status} for ${url}\n`
        );
        return null;
      }
      return await response.json();
    } catch (err) {
      process.stderr.write(
        `INaturalistClient: fetch error for ${url}: ${err.message}\n`
      );
      return null;
    }
  }

  #haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  #parseObservationLocation(locationStr) {
    if (!locationStr) return null;
    const parts = locationStr.split(',').map((p) => p.trim());
    if (parts.length === 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
    return null;
  }

  #getNearestDistance(lat, lng, results) {
    let minDist = null;

    for (const result of results) {
      if (!result.location) continue;
      const obsLoc = this.#parseObservationLocation(result.location);
      if (!obsLoc) continue;

      const dist = this.#haversineKm(lat, lng, obsLoc.lat, obsLoc.lng);
      if (minDist === null || dist < minDist) {
        minDist = dist;
      }
    }

    return minDist;
  }

  #checkHotspotOverlap(results) {
    const hotspotKeywords = [
      'park',
      'preserve',
      'forest',
      'wildlife',
      'lake',
      'river',
      'trail',
    ];

    for (const result of results) {
      if (!result.place_guess) continue;
      const guess = result.place_guess.toLowerCase();
      if (hotspotKeywords.some((keyword) => guess.includes(keyword))) {
        return true;
      }
    }

    return false;
  }

  #computeConfidence(count) {
    if (count >= 3) return 'high';
    if (count >= 1) return 'moderate';
    return 'low';
  }

  #buildInterpretation(
    speciesName,
    photoVerifiedCount,
    confidence,
    radiusKm,
    daysBack
  ) {
    if (confidence === 'high') {
      return `${photoVerifiedCount} photo-verified ${speciesName} reports within ${radiusKm}km in the last ${daysBack} days — high confidence this species is present.`;
    }
    if (confidence === 'moderate') {
      return `${photoVerifiedCount} photo-verified ${speciesName} report(s) nearby — moderate confidence.`;
    }
    return `No photo-verified ${speciesName} reports on iNaturalist within ${radiusKm}km. eBird audio-only IDs may need caution.`;
  }

  async getVerifiedSightings(
    speciesName,
    lat,
    lng,
    radiusKm = 30,
    daysBack = 14
  ) {
    this.#validateInputs(speciesName, lat, lng, radiusKm, daysBack);

    const cacheKey = `${speciesName},${lat},${lng},${radiusKm},${daysBack}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    await this.#enforceRateLimit();

    const { d1, d2 } = this.#getDateStrings(daysBack);
    const url =
      `${BASE_URL}/observations` +
      `?taxon_name=${encodeURIComponent(speciesName)}` +
      `&lat=${lat}` +
      `&lng=${lng}` +
      `&radius=${radiusKm}` +
      `&d1=${d1}` +
      `&d2=${d2}` +
      `&quality_grade=research` +
      `&photos=true` +
      `&per_page=10` +
      `&order_by=observed_on` +
      `&order=desc`;

    const data = await this.#get(url);

    let result = {
      species: speciesName,
      photoVerifiedCount: 0,
      confidence: 'low',
      interpretation: `iNaturalist data unavailable.`,
      mostRecentDate: null,
      nearestObservationKm: null,
      hotspotOverlap: false,
    };

    if (data && Array.isArray(data.results) && data.results.length > 0) {
      const photoVerifiedCount = data.results.length;
      const mostRecentDate = data.results[0].observed_on || null;
      const nearestObservationKm = this.#getNearestDistance(
        lat,
        lng,
        data.results
      );
      const hotspotOverlap = this.#checkHotspotOverlap(data.results);
      const confidence = this.#computeConfidence(photoVerifiedCount);
      const interpretation = this.#buildInterpretation(
        speciesName,
        photoVerifiedCount,
        confidence,
        radiusKm,
        daysBack
      );

      result = {
        species: speciesName,
        photoVerifiedCount,
        confidence,
        interpretation,
        mostRecentDate,
        nearestObservationKm,
        hotspotOverlap,
      };
    } else if (!data) {
      process.stderr.write(
        `INaturalistClient: No data returned for ${speciesName}\n`
      );
    }

    this.cache.set(cacheKey, result, CACHE_TTL_MS);
    return result;
  }
}
