import { Cache, FAVORABLE_WINDS, POOR_WINDS, SOUTHERLY_WINDS, NORTHERLY_WINDS, fetchWithRetry } from './utils.js';

const DISPLAY_TZ = process.env.BRIEFING_TIMEZONE || 'America/New_York';

/**
 * Extract the local wall-clock hour (0–23) for an ISO timestamp string,
 * using the configured display timezone instead of UTC.
 * Returns null if the string is not a valid date.
 * @param {string} isoString
 * @param {string} [tz]
 * @returns {number|null}
 */
function localHour(isoString, tz = DISPLAY_TZ) {
  const d = new Date(isoString);
  if (isNaN(d)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hourPart = parts.find(p => p.type === 'hour');
  return hourPart ? parseInt(hourPart.value, 10) : null;
}

export class NWSClient {
  static BASE_URL = 'https://api.weather.gov';
  static USER_AGENT = `(birding-planner, ${process.env.NWS_CONTACT_EMAIL || 'birding-briefing@example.com'})`;
  static CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  static POINTS_FORECAST_DELAY_MS = 250;

  constructor() {
    this.cache = new Cache();
  }

  async getBirdingWeather(lat, lng, dateStr = null) {
    // Default to today if not provided
    if (!dateStr) {
      const today = new Date();
      dateStr = today.toISOString().split('T')[0];
    }

    // Validate coordinates
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error(`Invalid latitude: ${lat}`);
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error(`Invalid longitude: ${lng}`);
    }

    // Check cache
    const cacheKey = `${lat},${lng},${dateStr}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Round coordinates to 4 decimal places
      const latRounded = Math.round(lat * 10000) / 10000;
      const lngRounded = Math.round(lng * 10000) / 10000;

      // Step 1: Get points metadata
      const pointsUrl = `${NWSClient.BASE_URL}/points/${latRounded},${lngRounded}`;
      const pointsData = await this._get(pointsUrl);

      if (!pointsData || !pointsData.properties || !pointsData.properties.forecastHourly) {
        process.stderr.write('NWSClient: No forecastHourly URL in points response\n');
        return this._unavailableResponse();
      }

      // Step 2: Wait 250ms before following the forecast URL
      await new Promise((resolve) => setTimeout(resolve, NWSClient.POINTS_FORECAST_DELAY_MS));

      // Step 3: Get hourly forecast
      const forecastUrl = pointsData.properties.forecastHourly;
      if (!forecastUrl.startsWith('https://api.weather.gov/')) {
        throw new Error('Unexpected forecastHourly URL domain: ' + forecastUrl);
      }
      const forecastData = await this._get(forecastUrl);

      if (!forecastData || !forecastData.properties || !Array.isArray(forecastData.properties.periods)) {
        process.stderr.write('NWSClient: No periods array in forecast response\n');
        return this._unavailableResponse();
      }

      // Step 4: Filter periods for overnight (20–23, 0–5) and morning (6–9) on target date
      const periods = forecastData.properties.periods;
      const overnightPeriods = [];
      const morningPeriods = [];

      for (const period of periods) {
        const hour = localHour(period.startTime);
        if (hour === null) continue;

        // Determine the local date for this period by formatting the full date
        const startTime = new Date(period.startTime);
        const localDateStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(startTime);

        // Overnight: 20–23 on dateStr or 0–5 on dateStr (morning of)
        const isOvernightEveOfDate =
          localDateStr === dateStr && (hour >= 20 && hour <= 23);
        const isOvernightMorningOfDate =
          localDateStr === dateStr && (hour >= 0 && hour <= 5);

        if (isOvernightEveOfDate || isOvernightMorningOfDate) {
          overnightPeriods.push(period);
        }

        // Morning: 6–9 on dateStr
        if (localDateStr === dateStr && hour >= 6 && hour <= 9) {
          morningPeriods.push(period);
        }
      }

      // Step 5: Compute overnight stats
      const overnight = this._computeWeatherStats(overnightPeriods);

      // Step 6: Compute morning stats
      const morning = this._computeWeatherStats(morningPeriods);
      if (morningPeriods.length > 0) {
        morning.tempF = morningPeriods[0].temperature ?? null;
      }

      // Step 7: Compute migration interpretation
      const migrationInterpretation = this._computeMigrationInterpretation(
        overnight,
        morning
      );

      const result = {
        overnight,
        morning,
        migrationInterpretation,
        weatherUnavailable: false,
      };

      // Cache the result
      this.cache.set(cacheKey, result, NWSClient.CACHE_TTL_MS);

      return result;
    } catch (err) {
      process.stderr.write(`NWSClient: ${err.message}\n`);
      return this._unavailableResponse();
    }
  }

  /**
   * Compute overnight or morning weather stats from a list of periods.
   * @param {Array} periods
   * @returns {{windDirection, windSpeedMph, precipProbability, cloudCover}}
   */
  _computeWeatherStats(periods) {
    const result = {
      windDirection: null,
      windSpeedMph: null,
      precipProbability: null,
      cloudCover: null,
    };

    if (periods.length === 0) {
      return result;
    }

    // Wind direction: most common string
    const windDirs = periods
      .map((p) => p.windDirection)
      .filter((d) => d != null);
    if (windDirs.length > 0) {
      const counts = {};
      for (const dir of windDirs) {
        counts[dir] = (counts[dir] ?? 0) + 1;
      }
      result.windDirection = Object.keys(counts).reduce((a, b) =>
        counts[a] > counts[b] ? a : b
      );
    }

    // Wind speed: average (parse from "12 mph" strings)
    const windSpeeds = periods
      .map((p) => {
        if (!p.windSpeed) return null;
        const match = String(p.windSpeed).match(/^(\d+)\s*mph$/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((s) => s != null);
    if (windSpeeds.length > 0) {
      result.windSpeedMph = Math.round(
        windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length
      );
    }

    // Precip probability: max
    const precips = periods
      .map((p) => p.probabilityOfPrecipitation?.value ?? null)
      .filter((p) => p != null);
    if (precips.length > 0) {
      result.precipProbability = Math.max(...precips);
    }

    // Cloud cover: infer from shortForecast
    const forecasts = periods.map((p) => p.shortForecast ?? '').join(' ').toLowerCase();
    if (forecasts.includes('clear') || forecasts.includes('sunny')) {
      result.cloudCover = 'Clear';
    } else if (forecasts.includes('partly')) {
      result.cloudCover = 'Partly Cloudy';
    } else {
      result.cloudCover = 'Cloudy';
    }

    return result;
  }

  /**
   * Generate plain-English migration interpretation from overnight and morning stats.
   * @param {object} overnight
   * @param {object} morning
   * @returns {string}
   */
  _computeMigrationInterpretation(overnight, morning) {
    const windDir = overnight.windDirection?.toUpperCase() ?? '';
    const windSpeed = overnight.windSpeedMph ?? 0;
    const precip = overnight.precipProbability ?? 0;
    const cloud = overnight.cloudCover ?? '';

    // Favorable winds + clear + low precip → favorable
    if (
      FAVORABLE_WINDS.has(windDir) &&
      precip < 30 &&
      cloud === 'Clear'
    ) {
      return 'Favorable migration conditions. South winds with clear skies overnight — expect new arrivals at dawn.';
    }

    // Poor winds → suppress movement
    if (POOR_WINDS.has(windDir)) {
      return 'Poor migration conditions. North winds suppress movement. Birds likely grounded.';
    }

    // High precip → rain suppresses but concentrates
    if (precip > 50) {
      return 'Rain overnight suppresses migration, but any birds that flew earlier may concentrate at good spots.';
    }

    // Light winds → unpredictable
    if (windSpeed < 5) {
      return 'Light winds — migration possible but difficult to predict intensity.';
    }

    // Default → mixed
    return 'Mixed conditions. Moderate migration possible.';
  }

  /**
   * Performs a GET request with NWS User-Agent and returns parsed JSON, or null on error.
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async _get(url) {
    try {
      const response = await fetchWithRetry(url, {
        headers: {
          'User-Agent': NWSClient.USER_AGENT,
        },
        signal: AbortSignal.timeout(15_000),
      }, { retries: 1, baseMs: 500, label: 'nws:forecast' });

      if (!response.ok) {
        process.stderr.write(`NWSClient: HTTP ${response.status} for ${url}\n`);
        return null;
      }

      return await response.json();
    } catch (err) {
      process.stderr.write(`NWSClient: fetch error for ${url}: ${err.message}\n`);
      return null;
    }
  }

  /**
   * Detect cold front passage and fallout conditions from NWS hourly forecast.
   *
   * Fetches the hourly forecast for the given location and date, then analyses
   * the overnight window (10pm–8am) for:
   *   - Wind shift: southerly winds early evening → northerly winds by dawn
   *   - Clearing: precip probability drops from >40% to <20%
   *   - Frontal passage: both wind shift + clearing detected
   *   - Fallout potential: rain/clouds during 10pm–2am, then clearing by 5–7am
   *
   * @param {number} lat
   * @param {number} lng
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Promise<{frontalPassage, falloutPotential, windShiftDetected, clearingDetected, frontalNote}>}
   */
  async detectFrontalPassage(lat, lng, dateStr) {
    const nullResult = {
      frontalPassage: false,
      falloutPotential: false,
      windShiftDetected: false,
      clearingDetected: false,
      frontalNote: null,
    };

    try {
      const latRounded = Math.round(lat * 10000) / 10000;
      const lngRounded = Math.round(lng * 10000) / 10000;

      // Use cache key distinct from getBirdingWeather
      const cacheKey = `frontal:${latRounded},${lngRounded},${dateStr}`;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey);
      }

      // Step 1: Get gridpoints metadata
      const pointsUrl = `${NWSClient.BASE_URL}/points/${latRounded},${lngRounded}`;
      const pointsData = await this._get(pointsUrl);

      if (!pointsData?.properties?.forecastHourly) {
        process.stderr.write('NWSClient.detectFrontalPassage: No forecastHourly URL\n');
        return nullResult;
      }

      await new Promise((resolve) => setTimeout(resolve, NWSClient.POINTS_FORECAST_DELAY_MS));

      // Step 2: Fetch hourly forecast
      const forecastUrl = pointsData.properties.forecastHourly;
      if (!forecastUrl.startsWith('https://api.weather.gov/')) {
        throw new Error('Unexpected forecastHourly URL domain: ' + forecastUrl);
      }
      const forecastData = await this._get(forecastUrl);
      const periods = forecastData?.properties?.periods;

      if (!Array.isArray(periods) || periods.length === 0) {
        process.stderr.write('NWSClient.detectFrontalPassage: No periods in forecast\n');
        return nullResult;
      }

      // Step 3: Categorise periods into evening (22–23), deep night (0–2), and dawn (5–7).
      // We use local-timezone hours and dates so that, e.g., "22:00 EDT" is treated as
      // 10 PM locally rather than the UTC-equivalent time. Previously this code used
      // getUTCHours() and toISOString().split('T')[0], which was off by the UTC offset
      // (up to 5 hours in EDT), making frontalPassage systematically wrong.

      const localDateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: DISPLAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      });

      // Build the local "next day" string by advancing dateStr by one calendar day.
      const [yr, mo, dy] = dateStr.split('-').map(Number);
      const nextDayUtc = new Date(Date.UTC(yr, mo - 1, dy + 1, 12, 0, 0));
      const nextDateStr = localDateFmt.format(nextDayUtc);

      const eveningPeriods = [];  // 22–23 local on dateStr (pre-frontal)
      const nightPeriods = [];    // 0–2 local on dateStr (peak migration / rain window)
      const dawnPeriods = [];     // 5–8 local on dateStr or next day (post-frontal clearing check)

      for (const period of periods) {
        const startTime = new Date(period.startTime);
        const periodDate = localDateFmt.format(startTime);
        const hour = localHour(period.startTime);
        if (hour === null) continue;

        if (periodDate === dateStr && hour >= 22) {
          eveningPeriods.push(period);
        }
        if (periodDate === dateStr && hour >= 0 && hour <= 2) {
          nightPeriods.push(period);
        }
        if ((periodDate === dateStr && hour >= 5) ||
            (periodDate === nextDateStr && hour <= 8)) {
          dawnPeriods.push(period);
        }
      }

      // Step 4: Wind shift detection — evening southerly → dawn northerly
      const eveningWindDirs = eveningPeriods
        .map(p => (p.windDirection ?? '').toUpperCase())
        .filter(Boolean);
      const dawnWindDirs = dawnPeriods
        .map(p => (p.windDirection ?? '').toUpperCase())
        .filter(Boolean);

      const eveningIsSoutherly = eveningWindDirs.length > 0 &&
        eveningWindDirs.some(d => SOUTHERLY_WINDS.has(d));
      const dawnIsNortherly = dawnWindDirs.length > 0 &&
        dawnWindDirs.some(d => NORTHERLY_WINDS.has(d));

      const windShiftDetected = eveningIsSoutherly && dawnIsNortherly;

      // Step 5: Clearing detection — precip drops from >40% to <20%
      const nightMaxPrecip = Math.max(
        0,
        ...nightPeriods.map(p => p.probabilityOfPrecipitation?.value ?? 0)
      );
      const dawnMaxPrecip = Math.max(
        0,
        ...dawnPeriods.map(p => p.probabilityOfPrecipitation?.value ?? 0)
      );

      const clearingDetected = nightMaxPrecip > 40 && dawnMaxPrecip < 20;

      // Step 6: Frontal passage = both signals
      const frontalPassage = windShiftDetected && clearingDetected;

      // Step 7: Fallout potential = rain or clouds during 10pm–2am, clearing by dawn
      // We use nightMaxPrecip > 40% as the rain proxy
      const falloutPotential = nightMaxPrecip > 40 && dawnMaxPrecip < 20;

      // Step 8: Compose plain-English note
      let frontalNote = null;
      if (frontalPassage) {
        frontalNote =
          `Cold front passage detected: southerly winds in the evening shift to northerly by dawn, ` +
          `with clearing after overnight rain (${Math.round(nightMaxPrecip)}% → ${Math.round(dawnMaxPrecip)}% precip). ` +
          `Expect concentrated migrants at dawn hotspots.`;
      } else if (falloutPotential) {
        frontalNote =
          `Fallout conditions possible: rain overnight (${Math.round(nightMaxPrecip)}% precip) ` +
          `clearing by dawn (${Math.round(dawnMaxPrecip)}%). ` +
          `Birds grounded during the night may concentrate at dawn. Check hotspots early.`;
      } else if (windShiftDetected) {
        frontalNote =
          `Wind shift detected (southerly evening → northerly dawn) suggesting frontal passage. ` +
          `Migration activity may be suppressed but watch for concentrated birds at shelter edges.`;
      }

      const result = {
        frontalPassage,
        falloutPotential,
        windShiftDetected,
        clearingDetected,
        frontalNote,
      };

      this.cache.set(cacheKey, result, NWSClient.CACHE_TTL_MS);
      return result;
    } catch (err) {
      process.stderr.write(`NWSClient.detectFrontalPassage: ${err.message}\n`);
      return nullResult;
    }
  }

  /**
   * Helper: return a standardized "unavailable" response object.
   * @returns {object}
   */
  _unavailableResponse() {
    return {
      weatherUnavailable: true,
      overnight: null,
      morning: null,
      migrationInterpretation: 'Weather data unavailable.',
    };
  }
}
