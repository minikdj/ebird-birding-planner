#!/usr/bin/env node
// validate-schema.js — Validates aggregate-output.json against the JSON Schema contract.
//
// Usage:
//   node scripts/validate-schema.js [path/to/file.json]   # file argument
//   node scripts/aggregate.js | node scripts/validate-schema.js   # stdin
//   npm run validate:schema -- aggregate-output.json
//
// Exit 0 on valid, exit 1 on invalid (all errors printed to stderr).

import Ajv from 'ajv';
import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'schemas', 'aggregate-output.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// strict: false — allows $schema and $id keywords without error, and permits
// union types ("type": ["string", "null"]) which are standard JSON Schema draft-07
// but flagged by AJV strict mode.
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const MAX_INPUT_BYTES = 10 * 1024 * 1024;  // 10 MB

const inputPath = process.argv[2];
let raw;
if (inputPath) {
  const stat = statSync(resolve(inputPath));
  if (stat.size > MAX_INPUT_BYTES) {
    process.stderr.write(`[validate-schema] input too large: ${stat.size} bytes (max ${MAX_INPUT_BYTES})\n`);
    process.exit(1);
  }
  raw = readFileSync(resolve(inputPath), 'utf8');
} else {
  // stdin path — read in chunks to enforce the cap
  raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_INPUT_BYTES) {
      process.stderr.write(`[validate-schema] stdin exceeded ${MAX_INPUT_BYTES} bytes\n`);
      process.exit(1);
    }
  }
}

const data = JSON.parse(raw);

if (validate(data)) {
  process.stderr.write(`[validate-schema] OK: matched ${schemaPath}\n`);
  process.exit(0);
}

process.stderr.write(`[validate-schema] FAILED: ${validate.errors.length} error(s)\n`);
for (const err of validate.errors) {
  const where = err.instancePath || '(root)';
  process.stderr.write(`  ${where}: ${err.message}\n`);
  if (err.params && Object.keys(err.params).length) {
    process.stderr.write(`     params: ${JSON.stringify(err.params)}\n`);
  }
}
process.exit(1);
