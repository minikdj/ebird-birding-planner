// lifelist.js — unified life list loading for both the pipeline and MCP server.
//
// Previously there were two parallel implementations:
//   - src/index.js (MCP): read ~/Downloads/ebird_world_life_list.csv at runtime,
//     stripped "(subspecies)" parentheticals, stored a Set with both forms.
//   - scripts/aggregate.js (pipeline): read pre-built data/life-list.json,
//     lowercased + stripped parentheticals, returned { set, total, source }.
//
// This module is the single source of truth. It prefers the JSON cache
// (built by scripts/build-life-list.js) and falls back to the CSV.

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { homedir } from 'os';

/**
 * Normalize a species common name for life-list comparison:
 *   - drop trailing parentheticals like "Red-tailed Hawk (calurus)"
 *   - lowercase
 *   - trim whitespace
 */
export function normalizeSpeciesName(name) {
  return String(name ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .trim();
}

/**
 * Path-traversal guard: only allow reading files within the user's home dir.
 * Returns true if path is safe, false otherwise.
 */
function isPathInHome(p) {
  try {
    const resolved = resolvePath(p);
    const home = homedir();
    return resolved === home || resolved.startsWith(home + '/');
  } catch {
    return false;
  }
}

function loadFromJsonSync(jsonPath) {
  try {
    const raw = readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.species)) return null;
    const set = new Set(data.species.map(normalizeSpeciesName).filter(Boolean));
    if (set.size === 0) return null;
    return { set, total: data.totalSpecies ?? set.size, source: jsonPath };
  } catch {
    return null;
  }
}

async function loadFromCsv(csvPath) {
  if (!isPathInHome(csvPath)) {
    process.stderr.write(`life list: refusing to read "${csvPath}" (outside home directory)\n`);
    return null;
  }
  try {
    const content = await readFile(csvPath, 'utf8');
    const lines = content.split('\n');
    const headers = (lines[0] ?? '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const nameCol = headers.findIndex(h => h === 'Common Name');
    if (nameCol < 0) {
      process.stderr.write('life list CSV: could not find "Common Name" column\n');
      return null;
    }
    const set = new Set();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = line.split(',');
      if (fields.length <= nameCol) continue;
      const name = fields[nameCol].trim().replace(/^"|"$/g, '');
      const normalized = normalizeSpeciesName(name);
      if (normalized) set.add(normalized);
    }
    if (set.size === 0) return null;
    return { set, total: set.size, source: csvPath };
  } catch (err) {
    process.stderr.write(`life list CSV error: ${err.message}\n`);
    return null;
  }
}

/**
 * Synchronous loader — prefers pre-built JSON, optionally falls back to a CSV
 * (sync read; only used by the pipeline scripts that already load CSVs sync).
 *
 * @param {{ jsonPath?: string, csvPath?: string|null }} opts
 * @returns {{ set: Set<string>, total: number, source: string }|null}
 */
export function loadLifeListSync({ jsonPath, csvPath = null } = {}) {
  if (jsonPath) {
    const fromJson = loadFromJsonSync(jsonPath);
    if (fromJson) return fromJson;
  }
  if (csvPath) {
    // Sync CSV path: use readFileSync for symmetry. Most callers prefer JSON.
    if (!isPathInHome(csvPath)) {
      process.stderr.write(`life list: refusing to read "${csvPath}" (outside home directory)\n`);
      return null;
    }
    try {
      const content = readFileSync(csvPath, 'utf8');
      const lines = content.split('\n');
      const headers = (lines[0] ?? '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const nameCol = headers.findIndex(h => h === 'Common Name');
      if (nameCol < 0) return null;
      const set = new Set();
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const fields = line.split(',');
        if (fields.length <= nameCol) continue;
        const name = fields[nameCol].trim().replace(/^"|"$/g, '');
        const normalized = normalizeSpeciesName(name);
        if (normalized) set.add(normalized);
      }
      if (set.size === 0) return null;
      return { set, total: set.size, source: csvPath };
    } catch (err) {
      process.stderr.write(`life list CSV error: ${err.message}\n`);
      return null;
    }
  }
  return null;
}

/**
 * Async loader — prefers pre-built JSON, falls back to CSV.
 * Both paths are optional; if neither yields data, returns null.
 *
 * @param {{ jsonPath?: string, csvPath?: string|null }} opts
 * @returns {Promise<{ set: Set<string>, total: number, source: string }|null>}
 */
export async function loadLifeList({ jsonPath, csvPath = null } = {}) {
  if (jsonPath) {
    const fromJson = loadFromJsonSync(jsonPath);
    if (fromJson) return fromJson;
  }
  if (csvPath) {
    return await loadFromCsv(csvPath);
  }
  return null;
}

/**
 * @param {string} speciesName - common name (may include "(subspecies)" suffix)
 * @param {{ set: Set<string> }|null|undefined} lifeList
 * @returns {boolean} true if species is NOT on the life list (i.e. a lifer)
 */
export function isLifer(speciesName, lifeList) {
  if (!lifeList?.set) return false;
  return !lifeList.set.has(normalizeSpeciesName(speciesName));
}

/**
 * Inverse of isLifer — true if the species IS on the life list.
 */
export function isOnLifeList(speciesName, lifeList) {
  if (!lifeList?.set) return false;
  return lifeList.set.has(normalizeSpeciesName(speciesName));
}

/**
 * Default CSV path for the MCP server (env override + home-relative fallback).
 */
export function defaultCsvPath(env = process.env) {
  if (env.EBIRD_LIFE_LIST_CSV) return env.EBIRD_LIFE_LIST_CSV;
  try {
    return resolvePath(homedir(), 'Downloads', 'ebird_world_life_list.csv');
  } catch {
    return null;
  }
}
