import test from 'node:test'
import assert from 'node:assert/strict'
import { createParser, parse, CsvError } from '../src/csv.js'

function run(chunks, opts = {}) {
  const rows = []
  const p = createParser({ ...opts, onRow: (r) => rows.push(Array.from(r)) })
  for (const c of chunks) p.push(c)
  p.end()
  return rows
}
// every 2-way split, every 3-way split (short inputs), and char-by-char
function splits(s) {
  const out = [[s], Array.from(s), ['', s, '']]
  for (let i = 0; i <= s.length; i++) out.push([s.slice(0, i), s.slice(i)])
  if (s.length <= 24) for (let i = 1; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.push([s.slice(0, i), s.slice(i, j), s.slice(j)])
  return out
}
const BOM = '﻿'
const cases = [
  ['simple', 'a,b\nc,d\n', [['a', 'b'], ['c', 'd']]],
  ['no trailing newline', 'a,b\nc,d', [['a', 'b'], ['c', 'd']]],
  ['CRLF', 'a,b\r\nc,d\r\n', [['a', 'b'], ['c', 'd']]],
  ['lone CR', 'a\rb\rc', [['a'], ['b'], ['c']]],
  ['mixed newlines', 'a\r\nb\nc\rd', [['a'], ['b'], ['c'], ['d']]],
  ['quoted comma and newline', '"x,y","l1\nl2",z\n', [['x,y', 'l1\nl2', 'z']]],
  ['quoted CRLF kept verbatim', '"a\r\nb",c', [['a\r\nb', 'c']]],
  ['escaped quotes', '"he said ""hi""",""""', [['he said "hi"', '"']]],
  ['quote inside unquoted field', 'a"b,c""d', [['a"b', 'c""d']]],
  ['spaces preserved', ' a , b ', [[' a ', ' b ']]],
  ['empty fields', ',,\n,', [['', '', ''], ['', '']]],
  ['trailing delimiter', 'a,', [['a', '']]],
  ['empty lines skipped', '\n\na\n\n\nb\n\n', [['a'], ['b']]],
  ['empty quoted line kept', 'a\n""\nb', [['a'], [''], ['b']]],
  ['BOM stripped at start', BOM + 'a,b', [['a', 'b']]],
  ['BOM kept elsewhere', 'a,' + BOM + 'b', [['a', BOM + 'b']]],
  ['quoted then CR', '"a"\r"b"', [['a'], ['b']]],
  ['empty input', '', []],
  ['only newlines', '\r\n\n\r', []],
]
for (const [name, input, want] of cases) {
  test('R ' + name + ' (all chunkings)', () => {
    for (const chunks of splits(input)) assert.deepEqual(run(chunks), want, JSON.stringify(chunks))
  })
}
test('R custom delimiter', () => {
  for (const chunks of splits('a;"b;c";d\n1;2;3')) assert.deepEqual(run(chunks, { delimiter: ';' }), [['a', 'b;c', 'd'], ['1', '2', '3']])
})
test('R tab delimiter, comma is plain', () => { assert.deepEqual(parse('a,b\tc', { delimiter: '\t' }), [['a,b', 'c']]) })
for (const bad of ['"', '\n', '\r', '', ';;', 5]) {
  test('E bad delimiter throws RangeError: ' + JSON.stringify(bad), () => assert.throws(() => createParser({ delimiter: bad, onRow() {} }), RangeError))
}
test('E text after closing quote throws CsvError with line', () => {
  for (const chunks of splits('a\n"x"y,z')) {
    let err
    try { run(chunks) } catch (e) { err = e }
    assert.ok(err instanceof CsvError && err instanceof Error, 'CsvError expected')
    assert.equal(err.line, 2)
  }
})
test('E line counts newlines inside quotes', () => {
  let err
  try { parse('"a\nb\r\nc"\n"q"x') } catch (e) { err = e }
  assert.ok(err instanceof CsvError)
  assert.equal(err.line, 4)
})
test('E unterminated quote at end throws CsvError', () => {
  for (const chunks of splits('a,"b\nc')) assert.throws(() => run(chunks), CsvError)
})
test('E push or end after end throws', () => {
  const p = createParser({ onRow() {} })
  p.push('a'); p.end()
  assert.throws(() => p.push('b'), Error)
  assert.throws(() => p.end(), Error)
})
test('O rows are emitted synchronously as soon as complete', () => {
  const rows = []
  const p = createParser({ onRow: (r) => rows.push(r) })
  p.push('a,b\nc')
  assert.deepEqual(rows, [['a', 'b']])
  p.push(',d\n')
  assert.equal(rows.length, 2)
  p.end()
  assert.equal(rows.length, 2)
})
test('O large input with many chunks', () => {
  const line = '"q,""x""",plain,\r\n'
  const text = line.repeat(500)
  const chunks = []
  for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7))
  const rows = run(chunks)
  assert.equal(rows.length, 500)
  assert.deepEqual(rows[499], ['q,"x"', 'plain', ''])
})
