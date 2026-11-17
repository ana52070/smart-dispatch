import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, PatchError } from '../src/patch.js'

const NL = '\\ No newline at end of file'
const P = (...lines) => lines.join('\n') + '\n'
const throwsHunk = (fn, hunk) => {
  let err
  try { fn() } catch (e) { err = e }
  assert.ok(err instanceof PatchError, 'expected PatchError, got ' + err)
  assert.ok(err instanceof Error)
  assert.equal(err.hunk, hunk)
}

test('P01 replace a middle line', () => {
  assert.equal(applyPatch('1\n2\n3\n4\n5\n', P('@@ -2,3 +2,3 @@', ' 2', '-3', '+three', ' 4')).text, '1\n2\nthree\n4\n5\n')
})
test('P02 headers before the first hunk are ignored', () => {
  const patch = P('diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@ function foo()', '-a', '+A', ' b')
  assert.equal(applyPatch('a\nb\n', patch).text, 'A\nb\n')
})
test('P03 omitted counts mean 1', () => {
  assert.equal(applyPatch('a\nb\nc\n', P('@@ -2 +2 @@', '-b', '+B')).text, 'a\nB\nc\n')
})
test('P04 several hunks use original line numbers', () => {
  const src = Array.from({ length: 10 }, (_, i) => 'l' + (i + 1)).join('\n') + '\n'
  const patch = P('@@ -2,2 +2,4 @@', ' l2', '+x1', '+x2', ' l3', '@@ -8,2 +10,1 @@', '-l8', ' l9')
  const r = applyPatch(src, patch)
  assert.equal(r.text, 'l1\nl2\nx1\nx2\nl3\nl4\nl5\nl6\nl7\nl9\nl10\n')
  assert.deepEqual(r.hunks, [{ offset: 0, fuzz: 0 }, { offset: 0, fuzz: 0 }])
})
test('P05 negative offset', () => {
  const r = applyPatch('a\nb\nc\n', P('@@ -5,2 +5,2 @@', ' b', '-c', '+C'))
  assert.equal(r.text, 'a\nb\nC\n')
  assert.deepEqual(r.hunks, [{ offset: -3, fuzz: 0 }])
})
test('P06 nearest match wins, earlier one on a tie', () => {
  const src = 'x\nk\nv\ny\ny\nx\nk\nv\ny\n'
  // expected index 3; matches at 1 (distance 2) and 5 (distance 2)
  const r = applyPatch(src, P('@@ -4,2 +4,2 @@', ' k', '-v', '+V'))
  assert.equal(r.text, 'x\nk\nV\ny\ny\nx\nk\nv\ny\n')
  assert.equal(r.hunks[0].offset, -2)
})
test('P07 a hunk may not match before the end of the previous hunk', () => {
  const src = 'dup\nA\nB\ndup\nC\n'
  const patch = P('@@ -2,2 +2,2 @@', ' A', '-B', '+b', '@@ -1,1 +1,1 @@', '-dup', '+DUP')
  const r = applyPatch(src, patch)
  assert.equal(r.text, 'dup\nA\nb\nDUP\nC\n')
  assert.deepEqual(r.hunks[1], { offset: 3, fuzz: 0 })
})
test('P08 unmatched hunk throws PatchError with its index', () => {
  throwsHunk(() => applyPatch('a\nb\nc\n', P('@@ -1 +1 @@', '-a', '+A', '@@ -3 +3 @@', '-zzz', '+Z')), 2)
})
test('P09 fuzz ignores outer context and keeps the source lines', () => {
  const src = 'h\nCTX1-changed\nmid\nCTX2-changed\nt\n'
  const patch = P('@@ -2,3 +2,3 @@', ' CTX1', '-mid', '+MID', ' CTX2')
  throwsHunk(() => applyPatch(src, patch), 1)
  const r = applyPatch(src, patch, { fuzz: 1 })
  assert.equal(r.text, 'h\nCTX1-changed\nMID\nCTX2-changed\nt\n')
  assert.deepEqual(r.hunks, [{ offset: 0, fuzz: 1 }])
})
test('P10 lower fuzz preferred over a closer position', () => {
  const src = 'Q\nm\nR\nz\nz\nz\nz\nc1\nm\nc2\n'
  const patch = P('@@ -1,3 +1,3 @@', ' c1', '-m', '+M', ' c2')
  const r = applyPatch(src, patch, { fuzz: 2 })
  assert.equal(r.text, 'Q\nm\nR\nz\nz\nz\nz\nc1\nM\nc2\n')
  assert.deepEqual(r.hunks, [{ offset: 7, fuzz: 0 }])
})
test('P11 fuzz only drops context lines, never changed lines', () => {
  const src = 'a\nX\nc\n'
  throwsHunk(() => applyPatch(src, P('@@ -1,3 +1,3 @@', '-a', '+A', ' b', ' c'), { fuzz: 0 }), 1)
  const r = applyPatch(src, P('@@ -1,3 +1,3 @@', '-a', '+A', ' b', ' c'), { fuzz: 5 })
  assert.equal(r.text, 'A\nX\nc\n')
  assert.equal(r.hunks[0].fuzz, 2)
})
test('P12 CRLF source keeps CRLF everywhere', () => {
  const r = applyPatch('a\r\nb\r\nc\r\n', P('@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+B2', ' c'))
  assert.equal(r.text, 'a\r\nB\r\nB2\r\nc\r\n')
})
test('P13 CRLF patch applies to LF source', () => {
  assert.equal(applyPatch('a\nb\n', '@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+B\r\n').text, 'a\nB\n')
})
test('P14 new-side marker removes the final newline', () => {
  assert.equal(applyPatch('a\nb\n', P('@@ -2 +2 @@', '-b', '+B', NL)).text, 'a\nB')
})
test('P15 old-side marker: source without final newline gets one', () => {
  assert.equal(applyPatch('a\nb', P('@@ -2 +2 @@', '-b', NL, '+B')).text, 'a\nB\n')
})
test('P16 appending after an unterminated last line', () => {
  assert.equal(applyPatch('x\nlast', P('@@ -2 +2,2 @@', '-last', NL, '+last', '+added')).text, 'x\nlast\nadded\n')
})
test('P17 unterminated last line requires the marker', () => {
  throwsHunk(() => applyPatch('a\nb', P('@@ -1,2 +1,2 @@', '-a', '+A', ' b')), 1)
  assert.equal(applyPatch('a\nb', P('@@ -1,2 +1,2 @@', '-a', '+A', ' b', NL)).text, 'A\nb')
})
test('P18 marker on a context line applies to both sides', () => {
  assert.equal(applyPatch('a\nb', P('@@ -1,2 +1,3 @@', ' a', '+mid', ' b', NL)).text, 'a\nmid\nb')
})
test('P19 pure insertion after line a', () => {
  const r = applyPatch('1\n2\n3\n', P('@@ -2,0 +3,2 @@', '+x', '+y'))
  assert.equal(r.text, '1\n2\nx\ny\n3\n')
})
test('P20 insertion at the very start', () => {
  assert.equal(applyPatch('a\n', P('@@ -0,0 +1 @@', '+first')).text, 'first\na\n')
  assert.equal(applyPatch('', P('@@ -0,0 +1,2 @@', '+x', '+y')).text, 'x\ny\n')
})
test('P21 delete everything', () => {
  assert.equal(applyPatch('a\nb\n', P('@@ -1,2 +0,0 @@', '-a', '-b')).text, '')
})
test('P22 header count larger than the body throws', () => {
  throwsHunk(() => applyPatch('a\nb\n', P('@@ -1,3 +1,3 @@', ' a', '-b', '+B')), 1)
  throwsHunk(() => applyPatch('a\nb\nc\n', P('@@ -1 +1 @@', '-a', '+A', '@@ -3,2 +3,2 @@', ' c')), 2)
})
test('P23 extra body lines after the declared counts throw', () => {
  throwsHunk(() => applyPatch('a\nb\n', P('@@ -1 +1 @@', '-a', '+A', '+extra')), 1)
})
test('P24 trailing blank lines and junk after a hunk are ignored', () => {
  assert.equal(applyPatch('a\n', '@@ -1 +1 @@\n-a\n+A\n\n\n-- \n'.replace('-- \n', 'git signature\n')).text, 'A\n')
})
test('P25 empty line in a hunk body is an empty context line', () => {
  assert.equal(applyPatch('a\n\nb\n', '@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n').text, 'a\n\nB\n')
})
test('P26 bad body line and marker-first throw', () => {
  throwsHunk(() => applyPatch('a\n', P('@@ -1 +1 @@', '*a', '+A')), 1)
  throwsHunk(() => applyPatch('a\n', P('@@ -1 +1 @@', NL, '-a', '+A')), 1)
  throwsHunk(() => applyPatch('a\n', P('@@ -x +1 @@', '-a', '+A')), 1)
})
test('P27 no hunks returns the source unchanged', () => {
  assert.deepEqual(applyPatch('a\r\nb', '--- a\n+++ b\n'), { text: 'a\r\nb', hunks: [] })
})
test('P28 lone CR is line content', () => {
  assert.equal(applyPatch('a\rb\nc\n', P('@@ -1,2 +1,2 @@', ' a\rb', '-c', '+C')).text, 'a\rb\nC\n')
})
test('P29 added lines use the default line ending of the first line', () => {
  assert.equal(applyPatch('a\r\nb\n', P('@@ -2 +2,2 @@', ' b', '+c')).text, 'a\r\nb\nc\r\n')
})
