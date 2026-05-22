#!/usr/bin/env node
// send.js — Delivers a pre-built briefing email from a JSON draft file.
//
// The Routine agent writes the email body and subject, saves them as a JSON
// draft, then calls this script to handle delivery. Separating delivery from
// composition means the agent can focus on reasoning and writing while this
// script handles the mechanical send + fallback chain.
//
// Usage:
//   node scripts/send.js <path-to-briefing-draft.json>
//
// Draft JSON format:
//   {
//     "subject":   "[Birding] Migration active — HIGH · 2026-05-16",
//     "htmlBody":  "<html>...</html>"
//   }
//
// Recipient (emailTo) and sender (emailFrom) are always read from Routine secrets
// (BRIEFING_EMAIL_TO, BRIEFING_FROM_EMAIL). The draft JSON cannot override them.
//
// Exit codes:
//   0 — email sent or saved to disk fallback (read RESULT: line for actual outcome)
//   1 — unrecoverable error (missing draft file, missing required fields in draft)
//
// Note on trust boundary: draftPath comes from process.argv[2] and is validated to
// be within the repo root. The htmlBody is agent-generated from eBird/BirdCast/NWS
// API data — the Routine prompt instructs the agent to HTML-escape any externally
// sourced strings (species names, location names, forecast text) before inserting
// them into the HTML body.

import { readFile, mkdir, writeFile } from 'fs/promises';
import { statSync, realpathSync, existsSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import sanitizeHtml from 'sanitize-html';
import { toYMD } from '../src/utils.js';
import { loadConfig, ymdInTimezone } from '../src/config.js';

// ---------------------------------------------------------------------------
// HTML sanitization allowlist
// ---------------------------------------------------------------------------
// The Routine agent generates the HTML body from LLM output. Even though the
// prompt instructs it to HTML-escape externally sourced strings, we defense-in-
// depth sanitize before handing to any email provider. The allowlist below
// matches exactly the tags/attrs our design system uses (table-based email
// layout). Anything else is silently dropped.
const SANITIZE_OPTIONS = {
  allowedTags: ['table','tr','td','tbody','thead','div','span','img','a','p','strong','em','b','i','br','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote'],
  allowedAttributes: {
    '*': ['style','align','valign','width','height','cellpadding','cellspacing','border','colspan','rowspan'],
    'a': ['href','style','rel'],
    'img': ['src','alt','width','height','style'],
  },
  allowedSchemes: ['https'],
  allowedSchemesByTag: { img: ['https'] },
  disallowedTagsMode: 'discard',
  // M1: Lock down the CSS sink — only the subset our design system actually
  // uses is permitted. Notably absent: position, top/left/right/bottom,
  // z-index, transform, animation, expression, filter, visibility.
  allowedStyles: {
    '*': {
      'color':            [/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, /^rgb\((\s*\d{1,3}\s*,?){2,3}\s*\d{1,3}\s*\)$/i, /^(black|white|gray|grey|red|green|blue|yellow|orange)$/i],
      'background':       [/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, /^rgb\(/i, /^(transparent|white|black)$/i],
      'background-color': [/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, /^rgb\(/i, /^(transparent|white|black)$/i],
      'font-size':        [/^\d+(?:\.\d+)?(px|em|rem|%|pt)$/],
      'font-weight':      [/^(?:\d{3}|bold|normal|lighter|bolder)$/],
      'font-family':      [/^[A-Za-z0-9\s,'"-]+$/],
      'font-style':       [/^(normal|italic|oblique)$/],
      'text-align':       [/^(left|right|center|justify)$/],
      'text-decoration':  [/^(none|underline|line-through|overline)(\s+\S+)*$/],
      'text-transform':   [/^(none|uppercase|lowercase|capitalize)$/],
      'text-underline-offset': [/^\d+(?:\.\d+)?(px|em)$/],
      'text-decoration-thickness': [/^\d+(?:\.\d+)?(px|em)$/],
      'line-height':      [/^\d+(?:\.\d+)?(px|em|%)?$/],
      'letter-spacing':   [/^-?\d+(?:\.\d+)?(px|em)$/],
      'padding':          [/^(\d+(?:\.\d+)?(px|em|%)\s*){1,4}$/],
      'padding-top':      [/^\d+(?:\.\d+)?(px|em|%)$/],
      'padding-right':    [/^\d+(?:\.\d+)?(px|em|%)$/],
      'padding-bottom':   [/^\d+(?:\.\d+)?(px|em|%)$/],
      'padding-left':     [/^\d+(?:\.\d+)?(px|em|%)$/],
      'margin':           [/^(\d+(?:\.\d+)?(px|em|%)\s*){1,4}$/, /^auto$/],
      'margin-top':       [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'margin-right':     [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'margin-bottom':    [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'margin-left':      [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'width':            [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'max-width':        [/^\d+(?:\.\d+)?(px|em|%)$/],
      'min-width':        [/^\d+(?:\.\d+)?(px|em|%)$/],
      'height':           [/^\d+(?:\.\d+)?(px|em|%)$/, /^auto$/],
      'max-height':       [/^\d+(?:\.\d+)?(px|em|%)$/],
      'min-height':       [/^\d+(?:\.\d+)?(px|em|%)$/],
      'border':           [/^[\d.]+px\s+(solid|dashed|dotted|double)\s+(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgb\(.+\))$/i],
      'border-left':      [/^[\d.]+px\s+(solid|dashed|dotted|double)\s+(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgb\(.+\))$/i],
      'border-right':     [/^[\d.]+px\s+(solid|dashed|dotted|double)\s+(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgb\(.+\))$/i],
      'border-top':       [/^[\d.]+px\s+(solid|dashed|dotted|double)\s+(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgb\(.+\))$/i],
      'border-bottom':    [/^[\d.]+px\s+(solid|dashed|dotted|double)\s+(#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgb\(.+\))$/i],
      'border-radius':    [/^\d+(?:\.\d+)?(px|em|%)(\s+\d+(?:\.\d+)?(px|em|%))*$/],
      'border-collapse':  [/^(collapse|separate)$/],
      'display':          [/^(block|inline|inline-block|table|table-row|table-cell|none)$/],
      'vertical-align':   [/^(top|middle|bottom|baseline|sub|super|text-top|text-bottom)$/, /^-?\d+(?:\.\d+)?(px|em|%)$/],
      'box-shadow':       [/^[\w\s\d.()#,-]+$/],
      'opacity':          [/^[01](\.\d+)?$/],
      'white-space':      [/^(normal|nowrap|pre|pre-wrap|pre-line)$/],
      'object-fit':       [/^(contain|cover|fill|none|scale-down)$/],
      // Explicitly NOT allowed: position, top/left/right/bottom, z-index,
      // visibility, transform, animation, behavior, expression, filter
    },
  },
  // M3: Force rel="noopener noreferrer" and strip target on all anchors.
  // Defeats reverse-tabnabbing (window.opener navigation hijack).
  transformTags: {
    'a': (tagName, attribs) => {
      const out = { ...attribs };
      out.rel = 'noopener noreferrer';
      delete out.target;
      return { tagName, attribs: out };
    },
  },
};

/**
 * I6: Derive a plaintext alternative from HTML.
 * Converts block-level tags to newlines and surfaces <a href> URLs in
 * parenthetical form: "link text (https://url)" so the plaintext body is
 * useful on text-only clients and in email snippet previews.
 *
 * Example:
 *   <p>Chase the <a href="https://ebird.org/species/conwar">Connecticut Warbler</a>.</p>
 *   => "Chase the Connecticut Warbler (https://ebird.org/species/conwar)."
 */
function htmlToText(html) {
  // First pass: inline href values next to link text.
  // Replace <a href="URL">text</a> with "text (URL)" before stripping tags.
  let out = html.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    // Strip any nested tags from the link text (e.g. <strong> inside <a>)
    const plainText = text.replace(/<[^>]+>/g, '').trim();
    if (href && href !== plainText) {
      return `${plainText} (${href})`;
    }
    return plainText;
  });

  // Second pass: convert block-level closing tags to newlines.
  out = out.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, '');

  // Decode common HTML entities.
  out = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalize whitespace.
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^ /gm, '')
    .trim();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// briefing-output/ is always relative to the repo root, not the process cwd
const repoRoot = resolve(__dirname, '..');
const BRIEFING_OUTPUT_DIR = resolve(__dirname, '..', 'briefing-output');

// ---------------------------------------------------------------------------
// SendGrid helper
// ---------------------------------------------------------------------------

/**
 * Extract a bare email address from a "Display Name <addr@domain>" string.
 * Uses non-greedy match to handle any angle-bracket content correctly.
 */
function extractEmail(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // M6: Load all configuration through loadConfig() — no direct process.env reads below.
  const config = loadConfig();

  // --- Idempotency check (before any work) ---
  const ymd = ymdInTimezone(new Date(), config.timezone);
  const briefingOutputDir = BRIEFING_OUTPUT_DIR;
  const finalMarker   = join(briefingOutputDir, `.sent-${ymd}.marker`);
  const pendingMarker = join(briefingOutputDir, `.pending-${ymd}-${process.pid}.marker`);

  // Durable, cross-environment idempotency key passed to Resend. Unlike the
  // local marker files (which live on the working-tree filesystem and do NOT
  // survive a fresh Routine clone or a fresh GHA runner), this key dedupes at
  // Resend's servers for 24h. A manually-reran failed Routine, a platform
  // auto-retry, or a backup scheduled run will therefore never double-send.
  const idempotencyKey = deriveIdempotencyKey(config, ymd);

  if (!config.forceSend && existsSync(finalMarker)) {
    process.stdout.write(`[idempotency] Already sent for ${ymd} — exiting clean. Override with BRIEFING_FORCE_SEND=true.\n`);
    process.exit(0);
  }

  // M8: Atomic idempotency marker — write a pending marker with exclusive-create
  // flag. If two runs race, only one will succeed the open; the loser exits clean.
  // The pending marker is renamed to the final marker only after successful delivery.
  // If delivery fails, the pending marker is deleted so a retry can proceed.
  mkdirSync(briefingOutputDir, { recursive: true });

  let pendingWritten = false;
  if (!config.forceSend) {
    try {
      writeFileSync(pendingMarker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
      pendingWritten = true;
    } catch (e) {
      if (e.code === 'EEXIST') {
        process.stdout.write('[idempotency] Another process is already sending for this YMD — exiting clean.\n');
        process.exit(0);
      }
      throw e;
    }
  }

  const draftPath = process.argv[2];

  if (!draftPath) {
    if (pendingWritten) {
      try { require('fs').unlinkSync(pendingMarker); } catch (_) { /* best effort */ }
    }
    process.stderr.write('Usage: node scripts/send.js <briefing-draft.json>\n');
    process.exit(1);
  }

  // realpath-based containment check defeats symlink traversal: a symlink
  // inside the repo pointing to /etc/passwd would pass a plain resolve()
  // check but fail here because we resolve to the link target.
  let realDraftPath;
  try {
    realDraftPath = realpathSync(resolve(draftPath));
    const realRepoRoot = realpathSync(repoRoot);
    if (!realDraftPath.startsWith(realRepoRoot + sep)) {
      process.stderr.write('Error: draftPath must be within the repo root\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: cannot resolve draftPath "${draftPath}": ${err.message}\n`);
    process.exit(1);
  }

  // --- Read draft file ---
  let draft;
  try {
    // Warn if draft is stale (older than 30 minutes) — could indicate a previous run's draft
    const draftStat = statSync(realDraftPath);
    const ageMs = Date.now() - draftStat.mtimeMs;
    if (ageMs > 30 * 60 * 1000) {
      process.stderr.write(`WARNING: briefing-draft.json is ${Math.round(ageMs/60000)} minutes old — may be from a previous run\n`);
    }

    const raw = await readFile(realDraftPath, 'utf8');
    draft = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`send.js: Failed to read draft file "${draftPath}": ${err.message}\n`);
    process.exit(1);
  }

  const { subject: rawSubject, htmlBody } = draft;
  const subject = typeof rawSubject === 'string'
    ? rawSubject.replace(/[\r\n]/g, ' ').slice(0, 200)
    : rawSubject;

  if (!subject || typeof subject !== 'string') {
    process.stderr.write('send.js: Draft is missing required field "subject"\n');
    process.exit(1);
  }
  if (!htmlBody || typeof htmlBody !== 'string') {
    process.stderr.write('send.js: Draft is missing required field "htmlBody"\n');
    process.exit(1);
  }

  // Defense-in-depth: sanitize agent-generated HTML before delivery.
  const cleanHtml = sanitizeHtml(htmlBody, SANITIZE_OPTIONS);
  const textBody = htmlToText(cleanHtml);

  const resendKey = config.resendApiKey;
  // Always use config — draft JSON cannot override recipient or sender.
  const emailTo = config.emailTo;
  // @resend.dev only delivers to the Resend account owner — configure a verified
  // domain via BRIEFING_FROM_EMAIL for production use.
  const emailFrom = config.emailFrom
    || 'Birding Briefing <briefing@resend.dev>';

  const today = toYMD(new Date());

  // --- Attempt delivery ---
  let sent = false;

  if (!resendKey) {
    process.stderr.write('RESULT: EMAIL NOT SENT — RESEND_API_KEY is not configured.\n');
  } else if (!emailTo) {
    process.stderr.write('RESULT: EMAIL NOT SENT — BRIEFING_EMAIL_TO is not configured.\n');
    // Email regex: permissive but safe. Rejects whitespace and characters
    // that could break out of address contexts in headers (, ; < >). Accepts
    // plus-addressed (foo+tag@), dotted (foo.bar@), apostrophes, underscores.
    // We intentionally do not implement full RFC 5322 — these checks exist to
    // catch obvious config typos, not to validate every legal address.
  } else if (!/^[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+$/.test(emailTo)) {
    process.stderr.write(`RESULT: EMAIL NOT SENT — BRIEFING_EMAIL_TO appears malformed: "${emailTo}"\n`);
  } else {
    // --- Primary: Resend ---
    try {
      const resend = new Resend(resendKey);
      const response = await resend.emails.send({
        from: emailFrom,
        to: emailTo,
        subject,
        html: cleanHtml,
        text: textBody,
      }, {
        // Server-side dedup: a repeated send with the same key within 24h
        // returns the original email's id without delivering a second message.
        idempotencyKey,
      });

      if (response?.error) {
        // Resend returned an API-level error (domain not verified, rate limit, etc.)
        // Log it but fall through to the SendGrid fallback below.
        process.stderr.write(`send.js: Resend API error: ${JSON.stringify(response.error)}\n`);
      } else {
        const id = response?.data?.id ?? 'unknown';
        process.stdout.write(`RESULT: EMAIL SENT via Resend to ${emailTo} (id: ${id})\n`);
        sent = true;
      }
    } catch (err) {
      // Network failure, package missing, etc. — fall through to SendGrid.
      process.stderr.write(`send.js: Resend threw: ${err.message}\n`);
    }

    // --- Fallback: SendGrid ---
    // Runs whenever Resend failed (API error OR throw) — not only on network errors.
    if (!sent) {
      const sendgridKey = config.sendgridApiKey;
      if (sendgridKey) {
        try {
          const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sendgridKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: emailTo }] }],
              from: { email: extractEmail(emailFrom) },
              subject,
              // SendGrid spec: text/plain MUST come before text/html.
              content: [
                { type: 'text/plain', value: textBody },
                { type: 'text/html',  value: cleanHtml },
              ],
            }),
            signal: AbortSignal.timeout(10_000),
          });

          if (sgResponse.ok) {
            process.stdout.write(`RESULT: EMAIL SENT via SendGrid to ${emailTo}\n`);
            sent = true;
          } else {
            process.stderr.write(`send.js: SendGrid failed with HTTP ${sgResponse.status}\n`);
            await sgResponse.text().catch(() => {}); // consume body to release connection
          }
        } catch (sgErr) {
          process.stderr.write(`send.js: SendGrid threw: ${sgErr.message}\n`);
        }
      } else {
        process.stderr.write('send.js: SENDGRID_API_KEY not configured — no fallback available.\n');
      }
    }
  }

  // --- Final fallback: save HTML to disk (repo-relative path, not cwd-relative) ---
  if (!sent) {
    // Delivery failed — clean up pending marker so a retry can proceed.
    if (pendingWritten) {
      try { unlinkSync(pendingMarker); } catch (_) { /* best effort */ }
    }
    await mkdir(briefingOutputDir, { recursive: true });
    const filename = join(briefingOutputDir, `briefing-${today}.html`);
    await writeFile(filename, cleanHtml, 'utf8');
    process.stdout.write(`RESULT: HTML SAVED to ${filename} (no email sent — check secrets above)\n`);
  } else {
    // M8: Rename pending marker → final marker atomically.
    // Idempotency marker — prevents double-send on workflow re-run. Only
    // written when an actual provider accepted the message.
    if (pendingWritten) {
      try {
        renameSync(pendingMarker, finalMarker);
      } catch (e) {
        // Rename failed — write final marker directly as fallback.
        try {
          writeFileSync(finalMarker, JSON.stringify({ pid: process.pid, sentAt: new Date().toISOString() }));
        } catch (e2) {
          process.stderr.write(`send.js: failed to write idempotency marker: ${e2.message}\n`);
        }
      }
    } else {
      // forceSend mode — still write the final marker so caller can observe.
      try {
        await mkdir(briefingOutputDir, { recursive: true });
        await writeFile(finalMarker, JSON.stringify({ pid: process.pid, sentAt: new Date().toISOString(), forceSend: true }), 'utf8');
      } catch (err) {
        process.stderr.write(`send.js: failed to write idempotency marker: ${err.message}\n`);
      }
    }
  }

  process.exit(0);
}

// Guard: only run main() when executed directly, not when imported for testing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`send.js crashed: ${err.message}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exported helpers — used by tests to verify the real logic, not inline copies
// ---------------------------------------------------------------------------

/** Validate an email address with send.js's actual regex. */
export function validateEmail(addr) {
  return /^[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+$/.test(addr);
}

/**
 * Resolve and validate a draft file path against the repo root.
 * Returns the real resolved path if safe, or throws if outside the repo root.
 */
export function safeDraftPath(draftPath) {
  const realDraft = realpathSync(resolve(draftPath));
  const realRoot = realpathSync(repoRoot);
  if (!realDraft.startsWith(realRoot + sep)) {
    throw new Error('draftPath must be within the repo root');
  }
  return realDraft;
}

/**
 * Derive the Resend idempotency key.
 * - If config.idempotencyKey is set (on-demand workflow passes a per-dispatch
 *   value), use it verbatim.
 * - Otherwise default to a content-independent per-region-per-day key so the
 *   daily Routine dedupes across retries even on fresh environments. Content
 *   independence is deliberate: a retry regenerates the email with slightly
 *   different wording, but it must still dedupe against the original send.
 * @param {{ idempotencyKey?: string|null, region: string }} config
 * @param {string} ymd - YYYY-MM-DD in the configured timezone
 * @returns {string}
 */
export function deriveIdempotencyKey(config, ymd) {
  return config.idempotencyKey || `briefing-${config.region}-${ymd}`;
}

// Export htmlToText for testing
export { htmlToText };
