// media-client.js — Bird photo lookup via Macaulay Library (primary) and
// Wikipedia REST API (fallback). No API key required for either source.
//
// Usage:
//   import { MediaClient } from './media-client.js';
//   const media = new MediaClient();
//   const photo = await media.getTopPhoto('conwar', 'Connecticut Warbler');
//   // → { url, thumbnailUrl, photographer, attribution, source }
//
// Caching: per-species in-memory cache (1 week TTL). Photos for a species
// rarely change, so aggressive caching is safe and important for email
// generation speed (each Chase Target card needs a photo).

import { Cache } from './utils.js';

// Cache TTL: 7 days — photos for a species change rarely
const PHOTO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Macaulay Library CDN — all sizes confirmed working: 320 480 640 900 1200 1800
const ML_SEARCH_URL = 'https://search.macaulaylibrary.org/api/v1/search';
const ML_CDN_BASE = 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset';

// Wikipedia REST API — returns Wikimedia Commons thumbnail for any species
const WIKI_API_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary';

// Request timeout: 6s (media fetches are non-critical path)
const TIMEOUT_MS = 6000;

export class MediaClient {
  constructor() {
    this._cache = new Cache(PHOTO_CACHE_TTL);
  }

  /**
   * Get the top-rated photo for a bird species.
   *
   * @param {string} speciesCode  - eBird species code (e.g. "conwar"), OR null
   * @param {string} commonName   - Species common name (e.g. "Connecticut Warbler")
   * @returns {Promise<{
   *   url: string,           // Full-size image URL (640px wide, email-safe)
   *   thumbnailUrl: string,  // Small square thumbnail (320px)
   *   photographer: string,  // Photographer name (for attribution)
   *   attribution: string,   // Full attribution string
   *   source: 'macaulay' | 'wikipedia',
   *   rating: number | null, // Macaulay rating 0-5 (null for Wikipedia)
   * } | null>}
   */
  async getTopPhoto(speciesCode, commonName) {
    const cacheKey = speciesCode || commonName;
    if (!cacheKey) return null;

    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let photo = null;

    // Primary: Macaulay Library — highest quality curated birding photos
    if (speciesCode) {
      photo = await this._getMacaulayPhoto(speciesCode, commonName).catch(() => null);
    }

    // Fallback: Wikipedia REST API — Wikimedia Commons thumbnails, CC-licensed
    if (!photo && commonName) {
      photo = await this._getWikipediaPhoto(commonName).catch(() => null);
    }

    this._cache.set(cacheKey, photo);
    return photo;
  }

  /**
   * Get photos for multiple species in parallel (rate-limited to 3 concurrent).
   * Returns an object keyed by commonName → photo result.
   *
   * @param {Array<{speciesCode: string, commonName: string}>} species
   * @returns {Promise<Record<string, object | null>>}
   */
  async getPhotosForSpecies(species) {
    const results = {};
    const BATCH_SIZE = 3;

    for (let i = 0; i < species.length; i += BATCH_SIZE) {
      const batch = species.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(({ speciesCode, commonName }) =>
          this.getTopPhoto(speciesCode, commonName).then(photo => ({ commonName, photo }))
        )
      );
      for (const { commonName, photo } of batchResults) {
        results[commonName] = photo;
      }
      // Brief pause between batches to be a good citizen
      if (i + BATCH_SIZE < species.length) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Macaulay Library (Cornell Lab / eBird)
  // ---------------------------------------------------------------------------

  async _getMacaulayPhoto(speciesCode, commonName) {
    const params = new URLSearchParams({
      taxonCode: speciesCode,
      count:     '1',
      sort:      'rating_rank_desc',
      mediaType: 'p',   // p = photo
    });
    const url = `${ML_SEARCH_URL}?${params}`;

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) return null;

    const data = await resp.json().catch(() => null);
    if (!data) return null;

    const assets = data?.results?.content;
    if (!Array.isArray(assets) || assets.length === 0) return null;

    const asset = assets[0];
    const assetId = asset.assetId || asset.catalogId;
    if (!assetId) return null;

    // 640px wide — fits cleanly in a 600px max-width email container
    const photoUrl     = `${ML_CDN_BASE}/${assetId}/640`;
    // 320px thumbnail — used in notable sightings rows
    const thumbUrl     = `${ML_CDN_BASE}/${assetId}/320`;
    const photographer = asset.userDisplayName || 'Unknown photographer';
    const location     = asset.location || '';
    const date         = asset.obsDttm || '';
    const rating       = parseFloat(asset.rating) || null;

    const attribution = `Photo: ${photographer}${location ? ` · ${location}` : ''}${date ? ` · ${date}` : ''} (Macaulay Library #${assetId})`;

    return {
      url: photoUrl,
      thumbnailUrl: thumbUrl,
      photographer,
      attribution,
      source: 'macaulay',
      assetId,
      rating,
      macaulayUrl: asset.specimenUrl || `https://macaulaylibrary.org/asset/${assetId}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Wikipedia REST API (Wikimedia Commons fallback)
  // ---------------------------------------------------------------------------

  async _getWikipediaPhoto(commonName) {
    // Wikipedia titles are typically "Connecticut warbler" (title-cased first word)
    // Try exact form first, then capitalize-first-word form
    const title = encodeURIComponent(commonName.replace(/ /g, '_'));
    const url = `${WIKI_API_BASE}/${title}`;

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok) return null;

    const data = await resp.json().catch(() => null);
    if (!data) return null;

    const thumbnail  = data.thumbnail;
    const original   = data.originalimage;

    if (!thumbnail?.source) return null;

    // Use original if available (higher res), else thumbnail
    const photoUrl = original?.source || thumbnail.source;
    // Ensure we have a "medium" size — Wikipedia thumbnails can be large
    // The thumbnail URL has a pixel-width param we can bump to 640
    const mediumUrl = thumbnail.source.replace(/\/(\d+)px-/, '/640px-');
    const thumbUrl  = thumbnail.source.replace(/\/(\d+)px-/, '/320px-');

    return {
      url: mediumUrl,
      thumbnailUrl: thumbUrl,
      photographer: null,   // Wikipedia doesn't surface photographer in summary API
      attribution: `Image from Wikimedia Commons · Wikipedia: ${data.title}`,
      source: 'wikipedia',
      rating: null,
      wikiUrl: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${title}`,
    };
  }
}
