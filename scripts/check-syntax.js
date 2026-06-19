#!/usr/bin/env node
/*
 * Pre-ship compatibility check for web/index.html, per the SkyFrame spec:
 * the app must run on iOS Safari 12.5.x, which means no ES2020+ syntax.
 *
 * 1. Extracts every inline <script> block and parses it with `new Function`
 *    to catch plain syntax errors (the actual historical incidents were a
 *    stray apostrophe and a stray `?.`).
 * 2. Explicitly scans for optional chaining (`?.`) and nullish coalescing
 *    (`??`) tokens, which Node's own parser happily accepts but Safari 12
 *    does not — this is the check Node can't do for you.
 * 3. Flags ctx.roundRect( usage, which is also too new for the target.
 *
 * Run with: node scripts/check-syntax.js
 * Exits non-zero on any failure.
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(file, 'utf8');

let failed = false;

function fail(msg) {
  console.error('FAIL: ' + msg);
  failed = true;
}

const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let scriptCount = 0;
while ((match = scriptRe.exec(html))) {
  scriptCount++;
  const code = match[1];

  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (err) {
    fail('inline <script> #' + scriptCount + ' has a syntax error: ' + err.message);
  }

  // Optional chaining: a "?" directly followed by "." that isn't a ternary
  // expression like `cond ? .5 : x`. We approximate by requiring no space
  // and no digit immediately after the dot-adjacent question mark... in
  // practice ternaries in this codebase always have a space before "?", so
  // we flag any `?.` with no preceding whitespace+ternary pattern.
  const optionalChainMatches = code.match(/\w\?\.\w/g) || code.match(/\)\?\./g) || [];
  if (code.match(/[\w)\]]\?\.[a-zA-Z_$(]/)) {
    fail('inline <script> #' + scriptCount + ' contains optional chaining (?.) which iOS 12 Safari cannot parse');
  }

  if (/\?\?/.test(code)) {
    fail('inline <script> #' + scriptCount + ' contains nullish coalescing (??) which iOS 12 Safari cannot parse');
  }

  if (/\.roundRect\s*\(/.test(code)) {
    fail('inline <script> #' + scriptCount + ' calls ctx.roundRect(), which is unsupported on iOS 12 Safari');
  }
}

if (scriptCount === 0) {
  fail('no inline <script> blocks found in ' + file);
}

if (failed) {
  console.error('\nSyntax check FAILED. Fix the issues above before deploying.');
  process.exit(1);
} else {
  console.log('Syntax check passed: ' + scriptCount + ' inline script block(s) OK, no ES2020+ syntax found.');
}
