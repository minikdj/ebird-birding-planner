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
//     "htmlBody":  "<html>...</html>",
//     "emailTo":   "optional — overrides BRIEFING_EMAIL_TO env var",
//     "emailFrom": "optional — overrides BRIEFING_FROM_EMAIL env var"
//   }
//
// Exit codes:
//   0 — email sent (or saved to disk fallback)
//   1 — unrecoverable error (missing draft, missing required fields)

import { readFile, mkdir, writeFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLocalYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

  // --- Read draft file ---
  let draft;
  try {
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
  const emailTo = draft.emailTo || process.env.BRIEFING_EMAIL_TO;
  // @resend.dev only delivers to the account owner — configure a verified domain
  // via BRIEFING_FROM_EMAIL for production use.
  const emailFrom = draft.emailFrom
    || process.env.BRIEFING_FROM_EMAIL
    || 'Birding Briefing <briefing@resend.dev>';

  const today = toLocalYMD(new Date());

  // --- Attempt delivery ---
  let sent = false;

  if (!resendKey) {
    process.stderr.write('RESULT: EMAIL NOT SENT — RESEND_API_KEY is not configured.\n');
  } else if (!emailTo) {
    process.stderr.write('RESULT: EMAIL NOT SENT — BRIEFING_EMAIL_TO is not configured.\n');
  } else {
    // --- Primary: Resend ---
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(resendKey);
      const response = await resend.emails.send({
        from: emailFrom,
        to: emailTo,
        subject,
        html: htmlBody,
      });

      if (response?.error) {
        process.stderr.write(`RESULT: EMAIL NOT SENT — Resend API error: ${JSON.stringify(response.error)}\n`);
      } else {
        const id = response?.data?.id ?? 'unknown';
        process.stdout.write(`RESULT: EMAIL SENT via Resend to ${emailTo} (id: ${id})\n`);
        sent = true;
      }
    } catch (err) {
      process.stderr.write(`RESULT: Resend threw: ${err.message}\n`);

      // --- Fallback: SendGrid ---
      const sendgridKey = process.env.SENDGRID_API_KEY;
      if (sendgridKey && !sent) {
        try {
          const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sendgridKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: emailTo }] }],
              from: { email: emailFrom.replace(/^.*<(.+)>.*$/, '$1') || emailFrom },
              subject,
              content: [{ type: 'text/html', value: htmlBody }],
            }),
          });

          if (sgResponse.ok) {
            process.stdout.write(`RESULT: EMAIL SENT via SendGrid to ${emailTo}\n`);
            sent = true;
          } else {
            process.stderr.write(`RESULT: SendGrid failed with HTTP ${sgResponse.status}\n`);
          }
        } catch (sgErr) {
          process.stderr.write(`RESULT: SendGrid threw: ${sgErr.message}\n`);
        }
      }
    }
  }

  // --- Final fallback: save HTML to disk ---
  if (!sent) {
    await mkdir('./briefing-output', { recursive: true });
    const filename = `./briefing-output/briefing-${today}.html`;
    await writeFile(filename, htmlBody, 'utf8');
    process.stdout.write(`RESULT: HTML SAVED to ${filename} (no email sent — check secrets above)\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`send.js crashed: ${err.message}\n`);
  process.exit(1);
});
