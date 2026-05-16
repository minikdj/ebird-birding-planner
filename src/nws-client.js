export class NWSClient {
  static BASE_URL = 'https://api.weather.gov';
  static USER_AGENT = '(birding-planner, minikdj11@gmail.com)';
  static CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  static POINTS_FORECAST_DELAY_MS = 250;

  constructor() {
    this.cache = new Map();
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
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < NWSClient.CACHE_TTL_MS) {
      return cached.data;
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
      const forecastData = await this._get(forecastUrl);

      if (!forecastData || !Array.isArray(forecastData.properties.periods)) {
        process.stderr.write('NWSClient: No periods array in forecast response\n');
        return this._unavailableResponse();
      }

      // Step 4: Filter periods for overnight (20–23, 0–5) and morning (6–9) on target date
      const periods = forecastData.properties.periods;
      const overnightPeriods = [];
      const morningPeriods = [];

      for (const period of periods) {
        const startTime = new Date(period.startTime);
        const periodDate = startTime.toISOString().split('T')[0];
        const hour = startTime.getUTCHours();

        // Overnight: 20–23 on dateStr or 0–5 on dateStr (morning of)
        const isOvernightEveOfDate =
          periodDate === dateStr && (hour >= 20 && hour <= 23);
        const isOvernightMorningOfDate =
          periodDate === dateStr && (hour >= 0 && hour <= 5);

        if (isOvernightEveOfDate || isOvernightMorningOfDate) {
          overnightPeriods.push(period);
        }

        // Morning: 6–9 on dateStr
        if (periodDate === dateStr && hour >= 6 && hour <= 9) {
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
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
      });

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

    // S or SW winds + clear + low precip → favorable
    if (
      (windDir === 'S' || windDir === 'SW') &&
      precip < 30 &&
      cloud === 'Clear'
    ) {
      return 'Favorable migration conditions. South winds with clear skies overnight — expect new arrivals at dawn.';
    }

    // N or NW winds → poor
    if (windDir === 'N' || windDir === 'NW') {
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
      const response = await fetch(url, {
        headers: {
          'User-Agent': NWSClient.USER_AGENT,
        },
      });

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
