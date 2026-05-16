#!/usr/bin/env node
// Briefing script — called by the Routine agent after triage decides to send.
// Usage: node scripts/briefing.js [--quiet]
// Reads config from env vars. Sends email via Resend or saves HTML fallback.

import { mkdir, writeFile } from 'fs/promises';
import { BirdCastClient } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { DEFAULTS, formatNumber } from '../src/utils.js';

async function buildOutlook(birdcast, nws, config) {
  const days = [];
  for (let i = 1; i <= 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const [live, weather] = await Promise.all([
      birdcast.getLiveMigration(config.region, dateStr).catch(() => null),
      nws.getBirdingWeather(config.lat, config.lng, dateStr).catch(() => null),
    ]);

    const birds = live?.cumulativeBirds ?? 0;
    const isHigh = live?.isHigh ?? false;
    const wind = weather?.overnight?.windDirection ?? '?';
    const windSpeed = weather?.overnight?.windSpeedMph ?? 0;
    const precip = weather?.overnight?.precipProbability ?? 0;

    // Score: high migration + favorable south winds + low precip = best day
    const favorable = ['S', 'SW', 'SSW', 'SE'].includes(wind) && precip < 30;
    const poor = ['N', 'NW', 'NNW', 'NE'].includes(wind) || precip > 60;
    let outlook;
    if (isHigh || (birds > 300000 && favorable)) outlook = '★ Excellent';
    else if (birds > 100000 && favorable) outlook = '▲ Good';
    else if (birds > 50000 && !poor) outlook = '~ Moderate';
    else if (poor) outlook = '▽ Poor';
    else outlook = '– Quiet';

    days.push({ dayName, dateStr, birds, isHigh, wind, windSpeed, precip, outlook });
  }
  return days;
}

async function main() {
  const config = {
    ebirdKey: process.env.EBIRD_API_KEY,
    birdcastKey: process.env.BIRDCAST_API_KEY,
    resendKey: process.env.RESEND_API_KEY,
    emailTo: process.env.BRIEFING_EMAIL_TO,
    // Must be a verified sender domain in your Resend account.
    // @resend.dev only delivers to the account owner's email — set your own domain here.
    emailFrom: process.env.BRIEFING_FROM_EMAIL || 'Birding Briefing <briefing@resend.dev>',
    lat: parseFloat(process.env.BRIEFING_LAT || String(DEFAULTS.lat)),
    lng: parseFloat(process.env.BRIEFING_LNG || String(DEFAULTS.lng)),
    region: process.env.BRIEFING_REGION || DEFAULTS.regionCode,
    isQuiet: process.argv.includes('--quiet'),
  };

  if (!config.ebirdKey || !config.birdcastKey) {
    console.error('Missing required API keys (EBIRD_API_KEY, BIRDCAST_API_KEY)');
    process.exit(1);
  }

  const birdcast = new BirdCastClient(config.birdcastKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(config.ebirdKey);

  const today = new Date().toISOString().split('T')[0];

  let data;

  if (config.isQuiet) {
    const [live, weather] = await Promise.all([
      birdcast.getLiveMigration(config.region, today).catch(() => null),
      nws.getBirdingWeather(config.lat, config.lng, today).catch(() => null),
    ]);
    const notableObs = await ebird.getNearbyNotableObservations(config.lat, config.lng, 14, 50).catch(() => null);
    data = { live, weather, notableObs, hotspots: [], expectedSpecies: null, season: null };
  } else {
    const [live, season, expectedSpecies, weather, notableObs, nearbyHotspots] = await Promise.all([
      birdcast.getLiveMigration(config.region, today).catch(() => null),
      birdcast.getSeasonHistorical(config.region, today).catch(() => null),
      birdcast.getExpectedSpecies(config.region, today).catch(() => null),
      nws.getBirdingWeather(config.lat, config.lng, today).catch(() => null),
      ebird.getNearbyNotableObservations(config.lat, config.lng, 14, 50).catch(() => null),
      ebird.getNearbyHotspots(config.lat, config.lng, 50).catch(() => null),
    ]);

    const candidateHotspots = Array.isArray(nearbyHotspots)
      ? nearbyHotspots.sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0)).slice(0, 20)
      : [];

    const hotspotData = (await Promise.all(
      candidateHotspots.map(async (h) => {
        const obs = await ebird.getRecentObservations(h.locId, 7).catch(() => []);
        const speciesCount = new Set((obs || []).map((o) => o.speciesCode)).size;
        return { name: h.locName, locId: h.locId, speciesCount };
      })
    ))
      .sort((a, b) => b.speciesCount - a.speciesCount)
      .filter((h, i) => h.speciesCount > 0 || i < 3)
      .slice(0, 3);

    // Fetch 5-day forward outlook
    const outlook = await buildOutlook(birdcast, nws, config);

    data = { live, season, expectedSpecies, weather, notableObs, hotspots: hotspotData, outlook };
  }

  const intensity = data.live?.isHigh ? 'HIGH' : 'Moderate';
  let subject;
  let html;

  if (config.isQuiet) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 4);
    const futureDateStr = futureDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    subject = `[Birding] Migration quiet — check back ${futureDateStr}`;
    html = buildQuietHtml(data, today);
  } else {
    subject = `[Birding] Migration active — ${intensity} · ${today}`;
    html = buildFullHtml(data, today, config);
  }

  let sent = false;

  if (!config.resendKey) {
    console.error('RESULT: EMAIL NOT SENT — RESEND_API_KEY is not configured as a Routine secret.');
  } else if (!config.emailTo) {
    console.error('RESULT: EMAIL NOT SENT — BRIEFING_EMAIL_TO is not configured as a Routine secret.');
  } else {
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(config.resendKey);
      const response = await resend.emails.send({
        from: config.emailFrom,
        to: config.emailTo,
        subject,
        html,
      });
      if (response?.error) {
        console.error('RESULT: EMAIL NOT SENT — Resend API error:', JSON.stringify(response.error));
      } else {
        console.log(`RESULT: EMAIL SENT via Resend to ${config.emailTo} (id: ${response?.data?.id ?? 'unknown'})`);
        sent = true;
      }
    } catch (err) {
      console.error('RESULT: EMAIL NOT SENT — Resend threw:', err.message);
    }
  }

  if (!sent) {
    await mkdir('./briefing-output', { recursive: true });
    const filename = `./briefing-output/briefing-${today}.html`;
    await writeFile(filename, html);
    console.log(`RESULT: HTML SAVED to ${filename} (no email sent — fix secrets above)`);
  }

  process.exit(0);
}

function buildFullHtml(data, today, config) {
  const { live, weather, notableObs, hotspots, outlook } = data;

  const formattedBirds = live?.cumulativeBirds != null
    ? formatNumber(live.cumulativeBirds)
    : 'No data';

  const isHigh = live?.isHigh ?? false;
  const migrationDetail = isHigh
    ? 'High-intensity migration night — new arrivals likely at dawn.'
    : live?.cumulativeBirds != null
    ? 'Moderate migration activity overnight.'
    : 'Migration data unavailable for last night.';

  const weatherInterpretation = weather?.migrationInterpretation ?? 'Weather data unavailable.';
  const overnightWind = weather?.overnight?.windDirection && weather?.overnight?.windSpeedMph != null
    ? `${weather.overnight.windDirection} ${weather.overnight.windSpeedMph}mph`
    : 'N/A';
  const morningTemp = weather?.morning?.tempF ?? 'N/A';

  const bullet1 = isHigh
    ? `&#x25B2; HIGH migration night — ${formattedBirds} birds aloft`
    : `&#x25B6; Moderate migration — ${formattedBirds} birds aloft`;

  const notableSpecies = Array.isArray(notableObs)
    ? [...new Set(notableObs.map((o) => o.comName).filter(Boolean))]
    : [];

  const bullet2 = notableSpecies.length > 0
    ? `&#x2605; ${notableSpecies.length} notable species nearby: ${notableSpecies.slice(0, 3).map(escHtml).join(', ')}${notableSpecies.length > 3 ? ' +more' : ''}`
    : '&#x25BD; No notable species flagged in the last 14 days';

  const bullet3 = weatherInterpretation.length > 80
    ? weatherInterpretation.slice(0, 80) + '...'
    : weatherInterpretation;

  const hotspotRows = hotspots.length > 0
    ? hotspots.map((h, i) =>
        `<tr><td style="padding:6px 0;font-size:14px;">${i + 1}. ${escHtml(h.name)} — ${h.speciesCount} species this week</td></tr>`
      ).join('\n        ')
    : '<tr><td style="padding:6px 0;font-size:14px;color:#888;">No hotspot data available.</td></tr>';

  let notableSection = '';
  if (notableSpecies.length > 0) {
    const speciesListItems = notableSpecies.map((s) =>
      `<tr><td style="padding:4px 0;font-size:14px;">&#x2022; ${escHtml(s)}</td></tr>`
    ).join('\n        ');
    notableSection = `
    <tr><td style="padding:12px 20px 0;">
      <table width="100%" style="background:#fff;border-radius:6px;padding:16px;" cellpadding="0" cellspacing="0">
        <tr><td><strong style="font-size:13px;text-transform:uppercase;color:#555;letter-spacing:1px;">Notable Sightings (Last 14 Days)</strong></td></tr>
        ${speciesListItems}
      </table>
    </td></tr>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
    <tr><td style="background:#1a3a2a;padding:20px;color:#fff;">
      <h1 style="margin:0;font-size:20px;">Morning Birding Briefing</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#8bc4a0;">${today} &middot; Cincinnati, OH</p>
    </td></tr>
    <tr><td style="background:#fff;padding:20px;border-bottom:3px solid #1a3a2a;">
      <p style="margin:0;font-size:14px;line-height:1.8;">
        ${bullet1}<br>${bullet2}<br>${bullet3}
      </p>
    </td></tr>
    <tr><td style="padding:16px 20px 0;">
      <table width="100%" style="background:#fff;border-radius:6px;padding:16px;" cellpadding="0" cellspacing="0">
        <tr><td><strong style="font-size:13px;text-transform:uppercase;color:#555;letter-spacing:1px;">Migration Last Night</strong></td></tr>
        <tr><td style="font-size:24px;font-weight:bold;color:#1a3a2a;padding:8px 0;">${formattedBirds}</td></tr>
        <tr><td style="font-size:13px;color:#555;">${migrationDetail}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:12px 20px 0;">
      <table width="100%" style="background:#fff;border-radius:6px;padding:16px;" cellpadding="0" cellspacing="0">
        <tr><td><strong style="font-size:13px;text-transform:uppercase;color:#555;letter-spacing:1px;">Weather Outlook</strong></td></tr>
        <tr><td style="font-size:14px;padding:8px 0;">${weatherInterpretation}</td></tr>
        <tr><td style="font-size:13px;color:#555;">Overnight wind: ${escHtml(String(overnightWind))} &middot; Morning: ${escHtml(String(morningTemp))}&deg;F</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:12px 20px 0;">
      <table width="100%" style="background:#fff;border-radius:6px;padding:16px;" cellpadding="0" cellspacing="0">
        <tr><td><strong style="font-size:13px;text-transform:uppercase;color:#555;letter-spacing:1px;">Top Hotspots This Week</strong></td></tr>
        ${hotspotRows}
      </table>
    </td></tr>
    ${notableSection}
    ${(() => {
      const outlookRows = (outlook || []).map(d =>
        `<tr>
          <td style="padding:6px 0;font-size:14px;width:140px;">${escHtml(d.dayName)}</td>
          <td style="padding:6px 0;font-size:14px;width:100px;color:#555;">${escHtml(String(d.wind ?? ''))} ${escHtml(String(d.windSpeed ?? 0))}mph</td>
          <td style="padding:6px 0;font-size:14px;">${escHtml(d.outlook)}</td>
        </tr>`
      ).join('');
      return outlook?.length ? `
    <tr><td style="padding:12px 20px 0;">
      <table width="100%" style="background:#fff;border-radius:6px;padding:16px;" cellpadding="0" cellspacing="0">
        <tr><td colspan="3"><strong style="font-size:13px;text-transform:uppercase;color:#555;letter-spacing:1px;">5-Day Outlook</strong></td></tr>
        ${outlookRows}
      </table>
    </td></tr>` : '';
    })()}
    <tr><td style="padding:20px;font-size:11px;color:#888;text-align:center;">
      Powered by BirdCast, eBird, and NWS &middot; Data as of ${today}
    </td></tr>
  </table>
</body>
</html>`;
}

function buildQuietHtml(data, today) {
  const { notableObs } = data;
  const notableSpecies = Array.isArray(notableObs)
    ? [...new Set(notableObs.map((o) => o.comName).filter(Boolean))]
    : [];

  const lastNotable = notableSpecies.length > 0
    ? `<p style="margin:16px 0 0;font-size:14px;color:#555;">Last notable sighting: ${escHtml(notableSpecies[0])}</p>`
    : '';

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 4);
  const futureDateStr = futureDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
    <tr><td style="background:#fff;padding:32px;border-top:4px solid #1a3a2a;">
      <h2 style="margin:0 0 12px;font-size:18px;color:#1a3a2a;">Migration Quiet Period</h2>
      <p style="margin:0;font-size:14px;color:#333;line-height:1.7;">
        Migration activity is low today. No full briefing needed.
        Check back around <strong>${futureDateStr}</strong> for the next active window.
      </p>
      ${lastNotable}
      <p style="margin:24px 0 0;font-size:11px;color:#aaa;">
        ${today} &middot; BirdCast + eBird + NWS
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((err) => {
  console.error('Briefing script failed:', err.message);
  process.exit(1);
});
