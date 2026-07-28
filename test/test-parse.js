#!/usr/bin/env node

/**
 * test-parse.js — Unit tests for parseSegments (marpit/mermaid parsing)
 *
 * Usage:
 *   node test/test-parse.js
 */

'use strict'

const { parseSegments } = require('../src/cli')

let passed = 0
let failed = 0

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}`) }
}

function is(a, b, label) {
  ok(a === b, `${label} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

function deepEq(a, b, label) {
  const aStr = JSON.stringify(a)
  const bStr = JSON.stringify(b)
  ok(aStr === bStr, `${label} — expected ${bStr}, got ${aStr}`)
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — empty / no blocks')
// ───────────────────────────────────────────────────────────────────────────
deepEq(parseSegments(''), [], 'empty string')
deepEq(parseSegments('   '), [], 'whitespace only')
deepEq(parseSegments('hello world'), [{ type: 'text', content: 'hello world' }], 'plain text')

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — single marpit block')
// ───────────────────────────────────────────────────────────────────────────
{
  const result = parseSegments('```marpit\n# Slide 1\n---\nSlide 2\n```')
  deepEq(result, [
    { type: 'marpit', content: '# Slide 1\n---\nSlide 2' },
  ], 'marpit block only, no text')
}

{
  const result = parseSegments('Before\n```marpit\n# Title\n```\nAfter')
  deepEq(result, [
    { type: 'text', content: 'Before' },
    { type: 'marpit', content: '# Title' },
    { type: 'text', content: 'After' },
  ], 'marpit block with text before and after')
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — single mermaid block')
// ───────────────────────────────────────────────────────────────────────────
{
  const result = parseSegments('```mermaid\ngraph TD\n  A-->B\n```')
  deepEq(result, [
    { type: 'mermaid', content: 'graph TD\n  A-->B' },
  ], 'mermaid block only')
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — multiple blocks')
// ───────────────────────────────────────────────────────────────────────────
{
  const result = parseSegments(
    'A\n```mermaid\ng1\n```\nB\n```mermaid\ng2\n```\nC'
  )
  deepEq(result, [
    { type: 'text', content: 'A' },
    { type: 'mermaid', content: 'g1' },
    { type: 'text', content: 'B' },
    { type: 'mermaid', content: 'g2' },
    { type: 'text', content: 'C' },
  ], 'two mermaid blocks with text between')
}

{
  const result = parseSegments(
    '```marpit\ns1\n```\nText\n```mermaid\ng1\n```\n```marpit\ns2\n```'
  )
  deepEq(result, [
    { type: 'marpit', content: 's1' },
    { type: 'text', content: 'Text' },
    { type: 'mermaid', content: 'g1' },
    { type: 'marpit', content: 's2' },
  ], 'mixed marpit and mermaid blocks')
}

{
  const result = parseSegments(
    '```marpit\na\n```\n```marpit\nb\n```\n```mermaid\nc\n```'
  )
  deepEq(result, [
    { type: 'marpit', content: 'a' },
    { type: 'marpit', content: 'b' },
    { type: 'mermaid', content: 'c' },
  ], 'three blocks consecutively (marpit, marpit, mermaid)')
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — edge cases')
// ───────────────────────────────────────────────────────────────────────────
{
  const result = parseSegments('No fence here ```marpit\nbut unclosed')
  deepEq(result, [
    { type: 'text', content: 'No fence here ```marpit\nbut unclosed' },
  ], 'unclosed fence treated as text')
}

{
  const result = parseSegments('```marpit\n\n```')
  deepEq(result, [
    { type: 'marpit', content: '' },
  ], 'empty block content')
}

{
  const result = parseSegments('```mermaid\ngraph TD\n  A-->B\n```\ntrailing')
  deepEq(result, [
    { type: 'mermaid', content: 'graph TD\n  A-->B' },
    { type: 'text', content: 'trailing' },
  ], 'block followed by trailing text')
}

{
  const result = parseSegments('leading\n```mermaid\ng\n```')
  deepEq(result, [
    { type: 'text', content: 'leading' },
    { type: 'mermaid', content: 'g' },
  ], 'leading text before block')
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nparseSegments — no false positive for other fences')
// ───────────────────────────────────────────────────────────────────────────
{
  const result = parseSegments('```javascript\nvar x = 1;\n```')
  deepEq(result, [
    { type: 'text', content: '```javascript\nvar x = 1;\n```' },
  ], 'javascript fence is not marpit/mermaid')
}

{
  const result = parseSegments('```\nplain fence\n```')
  deepEq(result, [
    { type: 'text', content: '```\nplain fence\n```' },
  ], 'unnamed fence is not marpit/mermaid')
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n--- Results ---')
console.log(`  Passed: ${passed}`)
console.log(`  Failed: ${failed}`)
if (failed > 0) process.exit(1)
