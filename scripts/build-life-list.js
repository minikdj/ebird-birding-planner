#!/usr/bin/env node
// build-life-list.js — Pre-processes the user's eBird world life list CSV export into
// a fast-lookup JSON file used by aggregate.js to flag lifer opportunities.
//
// Input:  /Users/djm/Downloads/ebird_world_life_list.csv  (eBird "World Life List" export)
//         Format: Row #,Taxon Order,Category,Common Name,Scientific Name,Count,
//                 Location,S/P,Date,LocID,SubID,Exotic,Countable
//         Filters: Category = "species" AND Countable = "1"
// Output: data/life-list.json
//
// Run with: node scripts/build-life-list.js

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path, { resolve, sep } from 'path';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CSV_PATH = process.env.EBIRD_LIFE_LIST_CSV ||
  `${homedir()}/Downloads/ebird_world_life_list.csv`;

// Validate: CSV path must be inside the user's home directory.
// Prevents a compromised EBIRD_LIFE_LIST_CSV env var from reading /etc/passwd etc.
const realCsvPath = resolve(CSV_PATH);
const userHome = homedir();
if (!realCsvPath.startsWith(userHome + sep)) {
  process.stderr.write(`ERROR: EBIRD_LIFE_LIST_CSV must be inside ${userHome}; got ${realCsvPath}\n`);
  process.exit(1);
}

const OUTPUT_PATH = path.join(REPO_ROOT, 'data', 'life-list.json');

/**
 * Strip parenthetical subspecies from a common name.
 * e.g. "Canada Goose (interior)" → "Canada Goose"
 * e.g. "Yellow-rumped Warbler (Myrtle)" → "Yellow-rumped Warbler"
 */
function stripParenthetical(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Normalize a species name for lookup:
 * lowercase, trim, strip parenthetical.
 */
function normalize(name) {
  return stripParenthetical(name).toLowerCase().trim();
}

// --- Read CSV ---
let csvText;
try {
  csvText = readFileSync(CSV_PATH, 'utf8');
} catch (err) {
  process.stderr.write(`build-life-list.js: Could not read CSV at ${CSV_PATH}: ${err.message}\n`);
  process.exit(1);
}

const lines = csvText.split('\n').filter(line => line.trim().length > 0);
if (lines.length < 2) {
  process.stderr.write('build-life-list.js: CSV appears empty or header-only\n');
  process.exit(1);
}

// Parse header to find required column indices (case-insensitive)
const headerLine = lines[0];
const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));

const commonNameIdx = headers.findIndex(h => h.toLowerCase() === 'common name');
const categoryIdx   = headers.findIndex(h => h.toLowerCase() === 'category');
const countableIdx  = headers.findIndex(h => h.toLowerCase() === 'countable');

for (const [label, idx] of [['Common Name', commonNameIdx], ['Category', categoryIdx], ['Countable', countableIdx]]) {
  if (idx === -1) {
    process.stderr.write(`build-life-list.js: Could not find "${label}" column in headers: ${headers.join(', ')}\n`);
    process.exit(1);
  }
}

process.stderr.write(
  `build-life-list.js: Columns — Common Name:${commonNameIdx}, Category:${categoryIdx}, Countable:${countableIdx}\n`
);

// Extract unique species names — only rows where Category="species" AND Countable="1"
const speciesSet = new Set();

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const fields = parseCsvLine(line);

  const category  = (fields[categoryIdx]  || '').trim().replace(/^"|"$/g, '');
  const countable = (fields[countableIdx] || '').trim().replace(/^"|"$/g, '');

  if (category !== 'species' || countable !== '1') continue;

  const commonName = (fields[commonNameIdx] || '').trim().replace(/^"|"$/g, '');
  if (commonName) {
    speciesSet.add(commonName);
  }
}

/**
 * Minimal CSV line parser that handles double-quoted fields.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

const speciesArray = Array.from(speciesSet).sort();
const totalSpecies = speciesArray.length;

if (totalSpecies === 0) {
  process.stderr.write('build-life-list.js: No species found in CSV — check column index\n');
  process.exit(1);
}

// Build output
const output = {
  generatedAt: new Date().toISOString().split('T')[0],
  totalSpecies,
  species: speciesArray,
};

// Ensure data/ directory exists
mkdirSync(path.join(REPO_ROOT, 'data'), { recursive: true });

writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

process.stderr.write(
  `build-life-list.js: Done. ${totalSpecies} unique species written to data/life-list.json\n`
);
process.stderr.write(`  First 5: ${speciesArray.slice(0, 5).join(', ')}\n`);
process.stderr.write(`  Last 5:  ${speciesArray.slice(-5).join(', ')}\n`);
