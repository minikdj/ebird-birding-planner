// ohio-birds-client.js — Ohio-birds LISTSERV scraper
// Fetches the public Miami University LISTSERV archive for the Ohio-birds mailing list
// and surfaces notable bird reports for the Cincinnati / SW Ohio area.
//
// Archive index is publicly accessible (no login required):
//   https://listserv.miamioh.edu/scripts/wa.exe?A0=OHIO-BIRDS
//
// Month index URL format:  ?A1=ind[YYMM]&L=OHIO-BIRDS   (e.g. ind2605 = May 2026)
//
// NOTE: Individual message bodies require LISTSERV login to read. We therefore
// work entirely from subject lines extracted from the index pages, which are
// freely visible and rich enough for daily briefing use.

export class OhioBirdsClient {
  // Base URL confirmed working 2026-05-17
  static BASE_URL = 'https://listserv.miamioh.edu/scripts/wa.exe';

  constructor() {
    this.baseUrl = OhioBirdsClient.BASE_URL;
    this.listName = 'OHIO-BIRDS';
  }

  /**
   * Get recent notable bird report subjects from the Ohio-birds LISTSERV.
   * Pulls the last two months' index pages if needed (to cover daysBack near month boundary)
   * and filters out digest/admin noise.
   *
   * @param {number} daysBack - Approximate number of recent days to surface (used to decide
   *   how many messages to include; we have no per-message timestamps from the index).
   * @returns {Promise<Array<{subject, url, source}>>}
   */
  async getRecentSightings(daysBack = 3) {
    try {
      const now = new Date();
      const months = this._monthsToFetch(now, daysBack);

      const allEntries = [];
      for (const { yy, mm } of months) {
        const indexUrl = `${this.baseUrl}?A1=ind${yy}${mm}&L=${this.listName}`;
        const response = await fetch(indexUrl, {
          headers: { 'User-Agent': 'birding-planner/1.0' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          process.stderr.write(`OhioBirdsClient: HTTP ${response.status} for ${indexUrl}\n`);
          continue;
        }
        const html = await response.text();
        const entries = this._parseIndexSubjects(html);
        allEntries.push(...entries);
      }

      // Take the most recent slice (last N messages; LISTSERV index is oldest-first)
      const recentCount = Math.max(15, daysBack * 8);
      const recent = allEntries.slice(-recentCount);

      // Filter to likely bird-report subjects and deduplicate by subject text
      const seen = new Set();
      const sightings = [];
      for (const entry of recent) {
        const key = entry.subject.toLowerCase().replace(/^re:\s*/i, '').trim();
        if (seen.has(key)) continue;
        if (!this._isBirdingSubject(entry.subject)) continue;
        seen.add(key);
        sightings.push({
          subject: entry.subject,
          url: entry.url,
          source: 'ohio-birds-listserv',
        });
      }

      return sightings;
    } catch (err) {
      process.stderr.write(`OhioBirdsClient: ${err.message}\n`);
      return [];
    }
  }

  /**
   * Determine which month index pages to fetch based on daysBack.
   * Near the start of a month we also fetch the previous month's index.
   * @param {Date} now
   * @param {number} daysBack
   * @returns {Array<{yy: string, mm: string}>}
   */
  _monthsToFetch(now, daysBack) {
    const yy = String(now.getUTCFullYear()).slice(2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const months = [{ yy, mm }];

    // If we're early in the month, also pull the previous month
    if (now.getUTCDate() <= daysBack + 1) {
      const prev = new Date(now);
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      months.unshift({
        yy: String(prev.getUTCFullYear()).slice(2),
        mm: String(prev.getUTCMonth() + 1).padStart(2, '0'),
      });
    }
    return months;
  }

  /**
   * Parse a LISTSERV month index page and return all subject+url entries.
   * The index renders subject lines as anchor text inside table cells:
   *   <a href="/scripts/wa.exe?A2=OHIO-BIRDS;[hash].2605&S=">Subject text</a>
   *
   * @param {string} html - HTML of the month index page
   * @returns {Array<{subject: string, url: string}>}
   */
  _parseIndexSubjects(html) {
    const entries = [];
    // Match anchors whose href is a LISTSERV A2 message link
    const re = /href="(\/scripts\/wa\.exe\?A2=[^"]+)"[^>]*>\s*([^<]{3,200}?)\s*<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = 'https://listserv.miamioh.edu' + m[1];
      const subject = m[2]
        .replace(/&#35;/g, '#')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, '')
        .trim();
      if (subject) entries.push({ subject, url });
    }
    return entries;
  }

  /**
   * Determine if a subject line looks like an actual birding report
   * (not a digest, admin notice, or pure social post).
   * @param {string} subject
   * @returns {boolean}
   */
  _isBirdingSubject(subject) {
    const s = subject.toLowerCase();

    // Drop digest/admin noise
    if (/\bohio-birds digest\b/.test(s)) return false;
    if (/\b(subscribe|unsubscribe|list admin|listserv|off topic|ot:|testing)\b/.test(s)) return false;
    if (/^re:\s*(ohio-birds digest|re:)/i.test(subject)) return false;

    // Accept if the subject mentions a species (no end \b — handles plurals like "Shorebirds")
    const hasSpecies = /\b(?:warbler|sparrow|flycatcher|thrush|vireo|hawk|falcon|owl|duck|goose|swan|grebe|loon|tern|gull|plover|sandpiper|shorebird|nuthatch|creeper|wren|tanager|grosbeak|bunting|martin|swallow|swift|hummingbird|woodpecker|cuckoo|rail|bittern|heron|egret|ibis|pelican|cormorant|kingfisher|crane|sora|gallinule|coot|nighthawk|nightjar|pipit|waxwing|chat|redstart|ovenbird|waterthrush|migrant)/i.test(s);

    // Migration / weather signals
    const hasMigrationNote = /migrat|fallout|irruption|hawkwatch/i.test(s);

    // Location-based trip report — on the ohio-birds list this is almost always a birding report.
    // Require a specific named place (park, lake, county, etc.) but no secondary keyword needed.
    const hasLocationReport = /\b(?:park|lake|reservoir|metro|county|refuge|woods|preserve|creek|river|pond|wetland|nwr|wildlife area|arboretum|nature center)\b/i.test(s);

    return hasSpecies || hasMigrationNote || hasLocationReport;
  }

  /**
   * Extract a likely species name from a subject line.
   * @param {string} subject
   * @returns {string}
   */
  _extractSpecies(subject) {
    return subject
      .replace(/^Re:\s*/i, '')
      .replace(/\s*[-–—]\s*(Hamilton|Butler|Warren|Clermont|Ohio|OH)\b.*/i, '')
      .trim() || subject;
  }

  /**
   * Extract a location hint from a subject line.
   * @param {string} subject
   * @returns {string|null}
   */
  _extractLocation(subject) {
    const countyMatch = subject.match(/([A-Z][a-z]+ County)/);
    if (countyMatch) return countyMatch[1];
    const parkMatch = subject.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Park|Lake|Reservoir|Refuge|Woods|Preserve|Metro|NWR))/);
    if (parkMatch) return parkMatch[1];
    return null;
  }
}
