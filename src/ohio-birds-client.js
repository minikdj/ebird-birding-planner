// ohio-birds-client.js — Ohio-birds LISTSERV scraper
// Fetches the public Miami University LISTSERV archive for the Ohio-birds mailing list
// and extracts full message bodies for the Cincinnati / SW Ohio area daily birding email.
//
// Architecture (no login required):
//   1. Fetch month index page  → extract {subject, A2-url} pairs
//   2. Filter subjects via keyword matcher
//   3. For each interesting message: fetch A2 page → extract A3 body URL → fetch body
//   4. Body text is in a <pre> block (plain-text email) or stripped from HTML iframe
//   5. Parse body for species list + location
//
// IMPORTANT: Must send a browser-like User-Agent.  A minimal UA returns 403 from IIS.
// The A3 endpoint serves email parts publicly (email addresses are masked as
// "[log in to unmask]" but the full message text is accessible).
//
// URL patterns:
//   Index:   ?A1=ind[YYMM]&L=OHIO-BIRDS   (e.g. ?A1=ind2605&L=OHIO-BIRDS)
//   Message: ?A2=OHIO-BIRDS;[hash].[YYMM]&S=
//   Body:    ?A3=ind[YYMM]&L=OHIO-BIRDS&E=[enc]&P=[pos]&B=[boundary]&T=[mimetype]...

export class OhioBirdsClient {
  static BASE_URL = 'https://listserv.miamioh.edu';
  static SCRIPTS  = 'https://listserv.miamioh.edu/scripts/wa.exe';

  // Browser-like UA required — IIS returns 403 for unrecognised agents
  static UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  constructor() {
    this.listName = 'OHIO-BIRDS';
    this._fetchOpts = {
      headers: { 'User-Agent': OhioBirdsClient.UA },
      signal: AbortSignal.timeout(12_000),
    };
  }

  /**
   * Get recent birding reports from the Ohio-birds LISTSERV.
   * Returns an array of { subject, body, species, location, url, source }.
   *
   * @param {number} daysBack   Approximate history window (uses last N messages from index)
   * @param {number} maxFetch   Maximum number of message bodies to fetch (default 8)
   * @returns {Promise<Array>}
   */
  async getRecentSightings(daysBack = 3, maxFetch = 8) {
    try {
      const months = this._monthsToFetch(new Date(), daysBack);
      const allEntries = [];

      for (const { yy, mm } of months) {
        const indexUrl = `${OhioBirdsClient.SCRIPTS}?A1=ind${yy}${mm}&L=${this.listName}`;
        const resp = await fetch(indexUrl, this._fetchOpts);
        if (!resp.ok) {
          process.stderr.write(`OhioBirdsClient: HTTP ${resp.status} for ${indexUrl}\n`);
          continue;
        }
        const html = await resp.text();
        allEntries.push(...this._parseIndexSubjects(html));
      }

      // Newest-first slice, deduplicate subject text, filter to birding subjects
      const recentCount = Math.max(20, daysBack * 8);
      const recent = allEntries.slice(-recentCount);
      const seen = new Set();
      const candidates = [];
      for (const entry of recent) {
        const key = entry.subject.toLowerCase().replace(/^re:\s*/i, '').trim().slice(0, 60);
        if (seen.has(key)) continue;
        if (!this._isBirdingSubject(entry.subject)) continue;
        seen.add(key);
        candidates.push(entry);
      }

      // Fetch message bodies for the best candidates (cap to avoid slow pipeline)
      const sightings = [];
      for (const entry of candidates.slice(0, maxFetch)) {
        try {
          const result = await this._fetchMessageBody(entry);
          if (result) sightings.push(result);
        } catch (err) {
          process.stderr.write(`OhioBirdsClient: body fetch error for "${entry.subject}": ${err.message}\n`);
          // Fall back to subject-only result
          sightings.push({
            subject: entry.subject,
            body: null,
            species: [],
            location: this._extractLocation(entry.subject),
            url: OhioBirdsClient.BASE_URL + entry.href,
            source: 'ohio-birds-listserv',
          });
        }
      }

      return sightings;
    } catch (err) {
      process.stderr.write(`OhioBirdsClient: ${err.message}\n`);
      return [];
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Determine which month index pages to fetch based on daysBack.
   */
  _monthsToFetch(now, daysBack) {
    const yy = String(now.getUTCFullYear()).slice(2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const months = [{ yy, mm }];
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
   * Parse a month index page and return {subject, href} pairs.
   */
  _parseIndexSubjects(html) {
    const entries = [];
    const re = /href="(\/scripts\/wa\.exe\?A2=[^"]+)"[^>]*>\s*([^<]{3,200}?)\s*<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const subject = m[2]
        .replace(/&#35;/g, '#').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
        .trim();
      if (subject) entries.push({ subject, href: m[1] });
    }
    return entries;
  }

  /**
   * Fetch an individual message's body text via the A2 → A3 pipeline.
   * Returns a fully-enriched sighting object or null on failure.
   */
  async _fetchMessageBody({ subject, href }) {
    const a2Url = OhioBirdsClient.BASE_URL + href;

    // Step 1: Fetch the A2 message page
    const a2Resp = await fetch(a2Url, this._fetchOpts);
    if (!a2Resp.ok) return null;
    const a2Html = await a2Resp.text();

    // Step 2: Find A3 body URL
    // Prefer text/plain (cleaner for parsing); fall back to text/html
    const a3Path = this._extractA3Url(a2Html, /* preferPlain= */ true);
    if (!a3Path) return null;

    // Step 3: Fetch the body
    const a3Url = a3Path.startsWith('http') ? a3Path : OhioBirdsClient.BASE_URL + a3Path;
    const a3Resp = await fetch(a3Url, this._fetchOpts);
    if (!a3Resp.ok) return null;
    const a3Html = await a3Resp.text();

    // Step 4: Extract body text
    const bodyText = this._extractBodyText(a3Html);
    if (!bodyText) return null;

    // Step 5: Parse body for species + location
    const species = this._parseSpecies(bodyText);
    const location = this._parseLocation(bodyText) ?? this._extractLocation(subject);

    return {
      subject,
      body: bodyText.slice(0, 1200), // cap body stored in output
      species,
      location,
      url: a2Url,
      source: 'ohio-birds-listserv',
    };
  }

  /**
   * Extract the best A3 body URL from an A2 page's HTML.
   * Prefers plain-text (for <pre> parsing); falls back to HTML.
   * @param {string} html
   * @param {boolean} preferPlain
   * @returns {string|null} Absolute or root-relative A3 URL
   */
  _extractA3Url(html, preferPlain = true) {
    // Collect ALL A3 href/src references
    const a3Re = /(?:href|src)="(\/scripts\/wa\.exe\?A3=[^"]+)"/gi;
    const a3Refs = [];
    let m;
    while ((m = a3Re.exec(html)) !== null) {
      a3Refs.push(m[1]);
    }

    // Also catch A3 URLs appearing in <pre> or JavaScript variables (not in attributes)
    const bareA3Re = /\/(scripts\/wa\.exe\?A3=[^"'\s<>]{10,300})/gi;
    while ((m = bareA3Re.exec(html)) !== null) {
      if (!a3Refs.some(r => r.includes(m[1].substring(0, 40)))) {
        a3Refs.push('/' + m[1]);
      }
    }

    if (a3Refs.length === 0) return null;

    const plain = a3Refs.find(r => r.includes('text%2Fplain') || r.includes('text/plain'));
    const htm   = a3Refs.find(r => r.includes('text%2Fhtml')  || r.includes('text/html'));

    return (preferPlain ? (plain ?? htm) : (htm ?? plain)) ?? a3Refs[0];
  }

  /**
   * Extract clean body text from an A3 response page.
   * Plain-text emails land in a <pre> block; HTML emails need tag-stripping.
   */
  _extractBodyText(html) {
    // Plain text email: content is in a <pre> block
    const preMatch = html.match(/<pre[^>]*>([\s\S]+?)<\/pre>/i);
    if (preMatch) {
      return preMatch[1]
        .replace(/<[^>]+>/g, '')      // strip any inline tags
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
        .replace(/\r\n/g, '\n').trim();
    }

    // HTML email: strip all tags, collapse whitespace
    const stripped = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    // Return the substantive portion — skip first 500 chars of CSS/boilerplate
    // and last 300 chars of LISTSERV footer
    const useful = stripped.slice(300, -200).trim();
    return useful.length > 30 ? useful : null;
  }

  /**
   * Parse species names from a plain-text bird report.
   * Lines are typically "Species Name" or "Species Name, heard".
   * Returns up to 12 species found.
   */
  _parseSpecies(text) {
    const KNOWN_SPECIES_WORDS = new Set([
      'warbler', 'sparrow', 'flycatcher', 'thrush', 'vireo', 'hawk', 'falcon', 'owl',
      'duck', 'goose', 'swan', 'grebe', 'loon', 'tern', 'gull', 'plover', 'sandpiper',
      'nuthatch', 'creeper', 'wren', 'tanager', 'grosbeak', 'bunting', 'martin', 'swallow',
      'swift', 'hummingbird', 'woodpecker', 'cuckoo', 'rail', 'bittern', 'heron', 'egret',
      'ibis', 'pelican', 'cormorant', 'kingfisher', 'crane', 'sora', 'gallinule', 'coot',
      'nighthawk', 'nightjar', 'pipit', 'waxwing', 'chat', 'redstart', 'ovenbird',
      'waterthrush', 'yellowthroat', 'parula', 'oriole', 'blackbird', 'starling', 'finch',
      'robin', 'catbird', 'mockingbird', 'thrasher', 'towhee', 'junco', 'meadowlark',
      'bobolink', 'dickcissel', 'kingbird', 'pewee', 'phoebe', 'martin', 'veery',
      'thrush', 'willet', 'dowitcher', 'dunlin', 'knot', 'turnstone', 'phalarope',
      'shorebird', 'waterfowl', 'raptor',
    ]);
    const NOISE_LINES = /^(re:|from:|date:|content-|received:|subject:|to:|cc:|reply|mime|boundary|ohio-birds|unsubscribe|www\.|http|\s*_{3,})/i;
    // Common prose words that indicate a sentence, not a species name
    const PROSE_WORDS = /\b(the|a|an|in|of|to|we|our|it|at|by|was|were|had|have|been|still|good|very|some|many|most|few|all|also|but|and|or|not|so|as|for|on|with|from|that|this|is|are|more|less|over|under|near|next|just|only|then|than|about|after|before|during|while|again|back|up|down|here|there|when|where|who|which|them|their|its)\b/i;

    const species = [];
    const seen = new Set();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || NOISE_LINES.test(line) || line.length > 70) continue;

      // Strip trailing status notes: ", heard", "x2", "(2)", "- 1", etc.
      const clean = line
        .replace(/[,;]\s*(heard|seen|observed|calling|singing|present|fly|flyover|overhead|male|female|imm|immature|juvenile|juv|adult|pair|2|3|4|5|6|7|8|9|1).*$/i, '')
        .replace(/\s*[\-–]\s*\d+.*$/, '')
        .replace(/\s*\(\d+\).*$/, '')
        .trim();
      if (!clean || clean.length < 5 || clean.length > 55) continue;

      const lower = clean.toLowerCase();
      // Must contain a known species word (no prose heuristic — too noisy)
      if (![...KNOWN_SPECIES_WORDS].some(w => lower.includes(w))) continue;
      // Must not read like a sentence
      if (PROSE_WORDS.test(clean)) continue;
      if (seen.has(lower)) continue;

      seen.add(lower);
      species.push(clean);
      if (species.length >= 12) break;
    }
    return species;
  }

  /**
   * Parse a location from the message body text.
   * Looks for place names, county names, park names.
   */
  _parseLocation(text) {
    // Try "Location Name, Date" or "Location Name (City)" patterns
    const locationLineRe = /^([A-Z][A-Za-z ]+(?:Park|Lake|Reservoir|Refuge|Metro|Woods|Preserve|Creek|NWR|County|Wildlife Area|Arboretum))\b/m;
    const m = text.match(locationLineRe);
    if (m) return m[1].trim();

    // County pattern
    const countyMatch = text.match(/([A-Z][a-z]+ County)/);
    if (countyMatch) return countyMatch[1];

    return null;
  }

  /**
   * Filter: is this subject line likely a birding report (not digest/admin)?
   */
  _isBirdingSubject(subject) {
    const s = subject.toLowerCase();
    if (/\bohio-birds digest\b/.test(s)) return false;
    if (/\b(subscribe|unsubscribe|list admin|listserv|testing)\b/.test(s)) return false;
    if (/^re:\s*(ohio-birds digest|re:)/i.test(subject)) return false;

    const hasSpecies = /\b(?:warbler|sparrow|flycatcher|thrush|vireo|hawk|falcon|owl|duck|goose|swan|grebe|loon|tern|gull|plover|sandpiper|shorebird|nuthatch|creeper|wren|tanager|grosbeak|bunting|martin|swallow|swift|hummingbird|woodpecker|cuckoo|rail|bittern|heron|egret|ibis|pelican|cormorant|kingfisher|crane|sora|gallinule|coot|nighthawk|nightjar|pipit|waxwing|chat|redstart|ovenbird|waterthrush|migrant)/i.test(s);
    const hasMigrationNote = /migrat|fallout|irruption|hawkwatch/i.test(s);
    const hasLocationReport = /\b(?:park|lake|reservoir|metro|county|refuge|woods|preserve|creek|river|pond|wetland|nwr|wildlife area|arboretum)\b/i.test(s);

    return hasSpecies || hasMigrationNote || hasLocationReport;
  }

  /**
   * Extract a location hint from a subject line alone (fallback when body unavailable).
   */
  _extractLocation(subject) {
    const countyMatch = subject.match(/([A-Z][a-z]+ County)/);
    if (countyMatch) return countyMatch[1];
    const parkMatch = subject.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Park|Lake|Reservoir|Refuge|Woods|Preserve|Metro|NWR))/);
    if (parkMatch) return parkMatch[1];
    return null;
  }
}
