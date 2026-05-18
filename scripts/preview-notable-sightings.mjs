#!/usr/bin/env node
// preview-notable-sightings.mjs — renders the new stacked-row Notable Sightings
// layout against realistic sample data so we can verify it visually at mobile,
// tablet, and desktop widths before any Routine retest.
//
// Usage:
//   node scripts/preview-notable-sightings.mjs
//   open /tmp/notable-preview.html
//
// The HTML wraps three iframes side-by-side at 360px (iPhone), 600px (max email
// width), and 800px (tablet) so a single page comparison shows the layout
// behaviour across the full responsive range.

import { writeFileSync } from 'fs';

// Sample data — mix of long/short names, with/without photo, with/without
// recording, lifer/non-lifer. Mirrors the recent Cincinnati emails so we
// stress-test the worst-case wrap cases (hyphenated species names).
const SAMPLES = [
  {
    species: 'Connecticut Warbler',
    location: 'Sharon Woods Park—Gorge Trail',
    date: '05/18 11:05',
    count: 1,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/237570321/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/103567031' },
  },
  {
    species: 'White-rumped Sandpiper',
    location: 'A. J. Jolly Park',
    date: '05/18 09:38',
    count: 2,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/182669171/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/116123881' },
  },
  {
    species: 'Mississippi Kite',
    location: 'Cornelius Lane & Court, Okeana',
    date: '05/17 19:35',
    count: 1,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/202384041/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/256194901' },
  },
  {
    species: 'Black-bellied Plover',
    location: 'A. J. Jolly Park',
    date: '05/17 16:35',
    count: 3,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/610326406/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/123456789' },
  },
  {
    species: 'Alder Flycatcher',
    location: 'Otto Armleder Memorial Park',
    date: '05/17 08:41',
    count: 1,
    isLifer: false,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/358558171/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/234567890' },
  },
  {
    species: 'Lark Sparrow',
    location: 'Oak Glen Nature Preserve',
    date: '05/16 13:20',
    count: 2,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/557055001/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/345678901' },
  },
  {
    species: 'Red-breasted Nuthatch',
    location: 'Gilmore Ponds MetroPark',
    date: '05/15 07:50',
    count: 1,
    isLifer: true,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/267198251/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/456789012' },
  },
  {
    species: 'Hooded Merganser',
    location: 'Camp Ernst Lake Park',
    date: '05/14 14:20',
    count: 1,
    isLifer: false,
    photo: { thumbnailUrl: 'https://cdn.download.ams.birds.cornell.edu/api/v1/asset/612274023/320' },
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/567890123' },
  },
  {
    species: 'Sandhill Crane',
    location: 'Fernald Preserve—Sycamore and Shingle Oak Trails',
    date: '05/14 09:18',
    count: 1,
    isLifer: false,
    photo: null,
    recording: null,
  },
  {
    species: "Bell's Vireo",
    location: 'Voice of America MetroPark',
    date: '05/13 16:49',
    count: 1,
    isLifer: true,
    photo: null,
    recording: { listenUrl: 'https://macaulaylibrary.org/asset/678901234' },
  },
];

// Render one observation row following the routine-prompt.md spec exactly.
function renderRow(obs) {
  const photoCell = obs.photo?.thumbnailUrl
    ? `<img src="${obs.photo.thumbnailUrl}" alt="${obs.species}" width="56" height="56" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:6px">`
    : `<div style="width:56px;height:56px;background:#f0f0f0;border-radius:6px"></div>`;

  const liferBadge = obs.isLifer
    ? `<span style="display:inline-block;background:#c0392b;color:#fff;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:10px;vertical-align:middle;line-height:1.4;white-space:nowrap;margin-right:6px">◉ LIFER</span>`
    : '';

  const listenPill = obs.recording
    ? `<a href="${obs.recording.listenUrl}" style="display:inline-block;background:#1a3a2a;color:#fff;text-decoration:none;font-size:11px;font-weight:bold;padding:6px 12px;border-radius:12px;white-space:nowrap">▶ Listen</a>`
    : '';

  return `
    <tr><td style="padding:10px 0;border-bottom:1px solid #e8e8e8">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="56" valign="top" style="padding-right:12px;width:56px">${photoCell}</td>
          <td valign="top" style="font-family:Arial,sans-serif">
            <div style="font-size:15px;font-weight:bold;color:#1a3a2a;line-height:1.3">
              ${liferBadge}<span style="vertical-align:middle">${obs.species}</span>
            </div>
            <div style="font-size:13px;color:#666;margin-top:3px;line-height:1.4">${obs.location}</div>
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:5px">
              <tr>
                <td style="font-size:12px;color:#999;font-family:Arial,sans-serif">${obs.date} · ×${obs.count}</td>
                <td align="right" style="font-family:Arial,sans-serif">${listenPill}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>`;
}

// Wrap rows in the full Notable Sightings section header + container
function renderSection() {
  const rows = SAMPLES.map(renderRow).join('');
  return `
<div style="padding:20px 16px;background:#fff;font-family:Arial,sans-serif">
  <h2 style="font-size:13px;font-weight:bold;color:#1a3a2a;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px 0;border-bottom:2px solid #1a3a2a;padding-bottom:8px">Notable / Rare Sightings</h2>
  <table cellpadding="0" cellspacing="0" border="0" width="100%">
    ${rows}
  </table>
  <div style="font-size:11px;color:#999;margin-top:12px">Showing ${SAMPLES.length} of 34 notable observations from the past 14 days.</div>
</div>`;
}

const sectionHtml = renderSection();

// Standalone single-section page — for viewport-resize testing with browser
// devtools or the Claude Preview tool. Body width is unconstrained so the
// viewport size determines layout.
const singlePage = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Notable Sightings — preview</title>
</head>
<body style="margin:0;background:#eaeaea;padding:8px">${sectionHtml}</body>
</html>`;

// Side-by-side wrapper page — three iframes at common widths for a quick
// at-a-glance comparison. Useful when sharing a screenshot.
const sectionDataUri = `data:text/html;charset=utf-8,${encodeURIComponent(singlePage)}`;
const comparisonPage = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Notable Sightings — width comparison</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; background: #f5f5f7; }
    h1 { font-size: 16px; color: #333; margin: 0 0 16px 0; }
    .row { display: flex; gap: 16px; align-items: flex-start; overflow-x: auto; padding-bottom: 20px; }
    .col { flex: 0 0 auto; }
    .col h2 { font-size: 12px; color: #666; margin: 0 0 6px 0; font-weight: 600; }
    iframe { border: 1px solid #ddd; background: #eaeaea; display: block; }
    .mobile { width: 360px; height: 1200px; }
    .email  { width: 600px; height: 1200px; }
    .tablet { width: 800px; height: 1200px; }
  </style>
</head>
<body>
  <h1>Notable Sightings — new stacked-row layout, rendered at 3 widths</h1>
  <div class="row">
    <div class="col">
      <h2>360px — iPhone portrait</h2>
      <iframe class="mobile" src="${sectionDataUri}"></iframe>
    </div>
    <div class="col">
      <h2>600px — max email width</h2>
      <iframe class="email" src="${sectionDataUri}"></iframe>
    </div>
    <div class="col">
      <h2>800px — tablet</h2>
      <iframe class="tablet" src="${sectionDataUri}"></iframe>
    </div>
  </div>
</body>
</html>`;

writeFileSync('/tmp/notable-preview.html', comparisonPage);
writeFileSync('/tmp/notable-single.html', singlePage);
console.log('Wrote /tmp/notable-preview.html (3-up comparison) and /tmp/notable-single.html (responsive single page)');
console.log('Run: open /tmp/notable-preview.html');
