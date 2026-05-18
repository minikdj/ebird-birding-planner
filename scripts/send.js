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
import { statSync, realpathSync, existsSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import sanitizeHtml from 'sanitize-html';
import { toYMD } from '../src/utils.js';

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
    'a': ['href','style','target','rel'],
    'img': ['src','alt','width','height','style'],
  },
  allowedSchemes: ['https','mailto'],
  allowedSchemesByTag: { img: ['https'] },
  disallowedTagsMode: 'discard',
};

/** Derive a plaintext alternative from sanitized HTML (strip tags, collapse whitespace). */
function htmlToText(html) {
  const stripped = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  // Decode-ish whitespace collapse; sanitize-html already decoded entities.
  return stripped.replace(/\s+/g, ' ').trim();
}

/** Compute YYYY-MM-DD in the given IANA timezone. */
function ymdInTimezone(date, timeZone) {
  // en-CA produces YYYY-MM-DD format
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    // Bad timezone → fall back to UTC YMD
    return toYMD(date);
  }
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
  // --- Idempotency check (before any work) ---
  const timezone = process.env.BRIEFING_TIMEZONE || 'America/New_York';
  const ymd = ymdInTimezone(new Date(), timezone);
  const markerPath = join(BRIEFING_OUTPUT_DIR, `.sent-${ymd}.marker`);
  const forceSend = process.env.BRIEFING_FORCE_SEND === 'true';
  if (!forceSend && existsSync(markerPath)) {
    process.stdout.write('Already sent today — skipping\n');
    process.exit(0);
  }

  // --- Header-injection defense on env-supplied addresses ---
  // CRLF in From/To headers can be used to inject additional headers (BCC,
  // Reply-To, etc.) into the SMTP envelope. Reject at startup.
  for (const envName of ['BRIEFING_FROM_EMAIL', 'BRIEFING_EMAIL_TO']) {
    const val = process.env[envName];
    if (val && /[\r\n]/.test(val)) {
      process.stderr.write(`send.js: ${envName} contains CR/LF — refusing to start\n`);
      process.exit(1);
    }
  }

  const draftPath = process.argv[2];

  if (!draftPath) {
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

  const resendKey = process.env.RESEND_API_KEY;
  // Always use env vars — draft JSON cannot override recipient or sender.
  const emailTo = process.env.BRIEFING_EMAIL_TO;
  // @resend.dev only delivers to the Resend account owner — configure a verified
  // domain via BRIEFING_FROM_EMAIL for production use.
  const emailFrom = process.env.BRIEFING_FROM_EMAIL
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
      const sendgridKey = process.env.SENDGRID_API_KEY;
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
    await mkdir(BRIEFING_OUTPUT_DIR, { recursive: true });
    const filename = join(BRIEFING_OUTPUT_DIR, `briefing-${today}.html`);
    await writeFile(filename, cleanHtml, 'utf8');
    process.stdout.write(`RESULT: HTML SAVED to ${filename} (no email sent — check secrets above)\n`);
  } else {
    // Idempotency marker — prevents double-send on workflow re-run. Only
    // written when an actual provider accepted the message.
    try {
      await mkdir(BRIEFING_OUTPUT_DIR, { recursive: true });
      await writeFile(markerPath, `sent ${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      process.stderr.write(`send.js: failed to write idempotency marker: ${err.message}\n`);
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
