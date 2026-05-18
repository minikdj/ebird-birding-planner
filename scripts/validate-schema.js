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
import { readFileSync } from 'fs';
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

const inputPath = process.argv[2];
let raw;
if (inputPath) {
  raw = readFileSync(resolve(inputPath), 'utf8');
} else {
  raw = readFileSync(0, 'utf8');  // stdin fd
}
const data = JSON.parse(raw);

if (validate(data)) {
  process.stderr.write(`[validate-schema] OK: matched ${schemaPath}\n`);
  process.exit(0);
}

process.stderr.write('[validate-schema] FAILED:\n');
for (const err of validate.errors) {
  process.stderr.write(
    `  ${err.instancePath || '/'} ${err.message} ${err.params ? JSON.stringify(err.params) : ''}\n`
  );
}
process.exit(1);
