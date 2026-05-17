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
import { statSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';
import { toYMD } from '../src/utils.js';

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
  const draftPath = process.argv[2];

  if (!draftPath) {
    process.stderr.write('Usage: node scripts/send.js <briefing-draft.json>\n');
    process.exit(1);
  }

  const resolvedDraft = resolve(draftPath);
  if (!resolvedDraft.startsWith(repoRoot + sep)) {
    process.stderr.write('Error: draftPath must be within the repo root\n');
    process.exit(1);
  }

  // --- Read draft file ---
  let draft;
  try {
    // Warn if draft is stale (older than 30 minutes) — could indicate a previous run's draft
    const draftStat = statSync(draftPath);
    const ageMs = Date.now() - draftStat.mtimeMs;
    if (ageMs > 30 * 60 * 1000) {
      process.stderr.write(`WARNING: briefing-draft.json is ${Math.round(ageMs/60000)} minutes old — may be from a previous run\n`);
    }

    const raw = await readFile(draftPath, 'utf8');
    draft = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`send.js: Failed to read draft file "${draftPath}": ${err.message}\n`);
    process.exit(1);
  }

  const { subject, htmlBody } = draft;

  if (!subject || typeof subject !== 'string') {
    process.stderr.write('send.js: Draft is missing required field "subject"\n');
    process.exit(1);
  }
  if (!htmlBody || typeof htmlBody !== 'string') {
    process.stderr.write('send.js: Draft is missing required field "htmlBody"\n');
    process.exit(1);
  }

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
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo)) {
    process.stderr.write(`RESULT: EMAIL NOT SENT — BRIEFING_EMAIL_TO appears malformed: "${emailTo}"\n`);
  } else {
    // --- Primary: Resend ---
    try {
      const resend = new Resend(resendKey);
      const response = await resend.emails.send({
        from: emailFrom,
        to: emailTo,
        subject,
        html: htmlBody,
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
              content: [{ type: 'text/html', value: htmlBody }],
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
    await writeFile(filename, htmlBody, 'utf8');
    process.stdout.write(`RESULT: HTML SAVED to ${filename} (no email sent — check secrets above)\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`send.js crashed: ${err.message}\n`);
  process.exit(1);
});
