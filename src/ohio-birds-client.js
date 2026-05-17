// ohio-birds-client.js — Ohio-birds LISTSERV scraper
// Fetches the public Miami University LISTSERV archive for the Ohio-birds mailing list
// and extracts recent rare/notable bird reports for the Cincinnati/SW Ohio area.
//
// AVAILABILITY STATUS: UNAVAILABLE
//
// The Miami University LISTSERV archive for ohio-birds is not publicly accessible
// via the standard LISTSERV CGI interface. Tested URLs returned HTTP 404:
//   - http://listserv.miamioh.edu/archives/ohio-birds.html
//   - http://listserv.miamioh.edu/cgi-bin/wa?A1=ind2605&L=ohio-birds
//   - https://listserv.miamioh.edu/cgi-bin/wa?A0=OHIO-BIRDS
//
// The archive may require authentication, or the CGI interface may have been
// disabled/moved. This client returns empty results gracefully so aggregate.js
// is unaffected. If the archive becomes available in the future, implement
// _parseMonthIndex() and _parseMessage() to scrape actual content.

export class OhioBirdsClient {
  // UNAVAILABLE flag — checked by callers to skip or note the source
  static UNAVAILABLE = true;
  static UNAVAILABLE_REASON =
    'Ohio-birds LISTSERV archive (listserv.miamioh.edu) is not publicly accessible. ' +
    'The CGI interface returned HTTP 404. The list may require login or have moved.';

  constructor() {
    this.baseUrl = 'http://listserv.miamioh.edu/cgi-bin/wa';
    this.listName = 'ohio-birds';
  }

  /**
   * Get recent rare-bird reports from the Ohio-birds listserv.
   *
   * Currently returns an empty array because the archive is not publicly accessible.
   * When the archive becomes available, implement actual scraping here.
   *
   * @param {number} daysBack - Number of days of history to search
   * @returns {Promise<Array>} Array of { species, location, date, source }
   */
  async getRecentSightings(daysBack = 3) { // eslint-disable-line no-unused-vars
    if (OhioBirdsClient.UNAVAILABLE) {
      process.stderr.write(
        `OhioBirdsClient: Skipping — ${OhioBirdsClient.UNAVAILABLE_REASON}\n`
      );
      return [];
    }

    // Future implementation: fetch and parse archive
    try {
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const indexUrl = `${this.baseUrl}?A1=ind${String(year).slice(2)}${month}&L=${this.listName}`;

      const response = await fetch(indexUrl, {
        headers: { 'User-Agent': 'birding-planner/1.0' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        process.stderr.write(
          `OhioBirdsClient: HTTP ${response.status} for ${indexUrl}\n`
        );
        return [];
      }

      const html = await response.text();
      const messageUrls = this._parseMonthIndex(html, daysBack);

      const sightings = [];
      for (const url of messageUrls.slice(0, 20)) { // cap at 20 messages
        try {
          const msgResponse = await fetch(url, {
            headers: { 'User-Agent': 'birding-planner/1.0' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!msgResponse.ok) continue;
          const msgHtml = await msgResponse.text();
          const result = this._parseMessage(msgHtml);
          if (result) sightings.push(result);
        } catch {
          // skip individual message failures
        }
      }

      return sightings;
    } catch (err) {
      process.stderr.write(`OhioBirdsClient: ${err.message}\n`);
      return [];
    }
  }

  /**
   * Parse a month index page and return message URLs for messages within daysBack days.
   * @param {string} html - HTML of the month index page
   * @param {number} daysBack - How many days back to look
   * @returns {string[]} Array of absolute message URLs
   */
  _parseMonthIndex(html, daysBack = 3) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);

    const urls = [];
    // LISTSERV archives typically have links like: <a href="?A2=ind2605&L=ohio-birds&P=123">Subject</a>
    // with date info nearby. This is a placeholder implementation.
    const linkRe = /href="([^"]*A2=[^"]+)"/gi;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const href = match[1];
      const absUrl = href.startsWith('http') ? href : `${this.baseUrl.replace(/\/[^/]*$/, '')}/${href.replace(/^\//, '')}`;
      urls.push(absUrl);
    }
    return urls;
  }

  /**
   * Fetch and parse a single listserv message for rare bird content.
   * @param {string} html - HTML of the message page
   * @returns {{ species, location, date, observer, source } | null}
   */
  _parseMessage(html) {
    // Extract subject
    const subjectMatch = html.match(/<title>([^<]+)<\/title>/i) ||
                         html.match(/Subject:\s*([^\n<]+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : '';

    // Extract body text (strip tags)
    const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    if (!this._isRareBirdReport(subject, bodyText)) return null;

    return {
      species: this._extractSpecies(subject),
      location: this._extractLocation(bodyText),
      date: new Date().toISOString().split('T')[0], // fallback to today
      observer: null,
      source: 'ohio-birds-listserv',
    };
  }

  /**
   * Determine if a message likely contains a rare bird report.
   * @param {string} subject
   * @param {string} body
   * @returns {boolean}
   */
  _isRareBirdReport(subject, body) {
    const combinedLower = (subject + ' ' + body).toLowerCase();

    // Must mention location context
    const hasLocation = /county|park|lake|reservoir|refuge|metro|woods|creek|river|preserve/i.test(combinedLower);

    // Must mention sighting action
    const hasSighting = /\b(seen|observed|found|reported|present|photographed|at|spotted)\b/i.test(combinedLower);

    // Must look like a bird report (not an admin message)
    const isAdmin = /subscribe|unsubscribe|digest|list admin|list-serv/i.test(combinedLower);

    // Subject should contain a capitalized word (likely species name)
    const hasSpeciesLike = /[A-Z][a-z]+ [A-Z][a-z]+/.test(subject);

    return hasLocation && hasSighting && !isAdmin && hasSpeciesLike;
  }

  /**
   * Extract a likely species name from the message subject.
   * @param {string} subject
   * @returns {string}
   */
  _extractSpecies(subject) {
    // Remove common prefixes like "Re:", location suffixes, etc.
    const clean = subject
      .replace(/^Re:\s*/i, '')
      .replace(/\s*[-–—]\s*(Hamilton|Butler|Warren|Clermont|Hamilton|Ohio|OH).*/i, '')
      .trim();
    return clean || subject;
  }

  /**
   * Extract a location from the message body.
   * @param {string} bodyText
   * @returns {string|null}
   */
  _extractLocation(bodyText) {
    // Try to find a county or named location
    const countyMatch = bodyText.match(/([A-Z][a-z]+ County)/);
    if (countyMatch) return countyMatch[1];

    const parkMatch = bodyText.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Park|Lake|Reservoir|Refuge|Woods|Preserve|Metro))/);
    if (parkMatch) return parkMatch[1];

    return null;
  }
}
