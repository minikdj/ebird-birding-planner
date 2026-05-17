#!/usr/bin/env node
// generate-email.js — reads triage-output.json and aggregate-output.json,
// calls Claude API, writes briefing-draft.json.
// Must be run from the repo root (GitHub Actions default).

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Load input files
// ---------------------------------------------------------------------------

const triagePath = join(repoRoot, 'triage-output.json');
const aggregatePath = join(repoRoot, 'aggregate-output.json');
const routinePromptPath = join(repoRoot, 'routine-prompt.md');

if (!existsSync(triagePath)) {
  process.stderr.write('ERROR: triage-output.json not found. Run triage.js first.\n');
  process.exit(1);
}

if (!existsSync(aggregatePath)) {
  process.stderr.write('ERROR: aggregate-output.json not found. Run aggregate.js first.\n');
  process.exit(1);
}

const triage = JSON.parse(readFileSync(triagePath, 'utf8'));
const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
const routinePrompt = readFileSync(routinePromptPath, 'utf8');

// ---------------------------------------------------------------------------
// 2. SILENT_SKIP fast path
// ---------------------------------------------------------------------------

if (triage.recommendation === 'SILENT_SKIP') {
  const locationName = process.env.BRIEFING_LOCATION_NAME || triage.region || 'your location';
  const score = triage.migrationScore ?? 0;
  const reason = triage.recommendationReason ?? 'Low migration activity';

  const draft = {
    subject: `[Birding] On-demand report for ${locationName} — nothing notable today`,
    htmlBody: `<p>Migration score: ${score}. ${reason}. No notable activity to report.</p>`,
  };

  writeFileSync(join(repoRoot, 'briefing-draft.json'), JSON.stringify(draft, null, 2));
  console.log('RESULT: SILENT_SKIP');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Validate API key
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write('ERROR: ANTHROPIC_API_KEY is not set.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Build system prompt
// ---------------------------------------------------------------------------

const locationName = process.env.BRIEFING_LOCATION_NAME || 'the requested location';
const timezone = process.env.BRIEFING_TIMEZONE || 'America/New_York';
const focusRaw = process.env.BRIEFING_FOCUS || '';
// Sanitize: strip anything outside alphanumeric, spaces, and common punctuation
// Prevents prompt injection via the focus field
const focus = focusRaw.replace(/[^A-Za-z0-9 ,.\-']/g, '').slice(0, 1000).trim();

const now = new Date();
const formattedDate = now.toLocaleDateString('en-US', {
  timeZone: timezone,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const focusLine = focus ? `SPECIAL FOCUS: ${focus}\n\n` : '';

const systemPrompt = `You are writing a birding briefing email for ${locationName}.
Today's date: ${formattedDate}.
${focusLine}
The following document defines the Design System and email structure you must follow exactly.
Pay special attention to the "DESIGN SYSTEM" section and "STEP 5 — WRITE THE EMAIL":

---
${routinePrompt}
---

You will receive triage data and aggregate data. Write the complete email.

IMPORTANT: Output ONLY a raw JSON object — no markdown, no code fences, no explanation:
{"subject":"...","htmlBody":"..."}`;

// ---------------------------------------------------------------------------
// 5. Build user message
// ---------------------------------------------------------------------------

const userMessage = `TRIAGE DATA:
${JSON.stringify(triage, null, 2)}

AGGREGATE DATA:
${JSON.stringify(aggregate, null, 2)}${focus ? `\n\nSPECIAL FOCUS NOTE: The user has requested special attention to: ${focus}` : ''}

Write the complete birding briefing email following the Design System and STEP 5 structure in the system prompt. Output ONLY the JSON object with "subject" and "htmlBody" keys.`;

// ---------------------------------------------------------------------------
// 6. Call Claude API
// ---------------------------------------------------------------------------

const client = new Anthropic({ apiKey });

let rawResponse;
try {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  rawResponse = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
} catch (err) {
  process.stderr.write(`ERROR: Claude API call failed: ${err.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7. Parse Claude's response
// ---------------------------------------------------------------------------

let draft;

// Attempt 1: direct JSON.parse
try {
  draft = JSON.parse(rawResponse);
} catch {
  // Attempt 2: extract from ```json code block
  const codeBlockMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      draft = JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // fall through to attempt 3
    }
  }

  // Attempt 3: match first { ... } in response
  if (!draft) {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        draft = JSON.parse(jsonMatch[0]);
      } catch {
        // fall through to error
      }
    }
  }
}

if (!draft || typeof draft.subject !== 'string' || typeof draft.htmlBody !== 'string') {
  process.stderr.write('ERROR: Failed to parse JSON from Claude response. Raw response:\n');
  process.stderr.write(rawResponse + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 8. Write briefing-draft.json
// ---------------------------------------------------------------------------

writeFileSync(join(repoRoot, 'briefing-draft.json'), JSON.stringify(draft, null, 2));
console.log('RESULT: EMAIL DRAFT WRITTEN');
