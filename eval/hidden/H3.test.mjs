import test from 'node:test'
import assert from 'node:assert/strict'
import { match } from '../src/glob.js'

const cases = [
  // [pattern, path, expected, options?]
  ['G01', 'a/*.js', 'a/b.js', true], ['G01', 'a/*.js', 'a/b/c.js', false], ['G01', 'a*b', 'ab', true],
  ['G02', '?.js', 'a.js', true], ['G02', '?.js', 'ab.js', false], ['G02', 'a?c', 'a/c', false],
  ['G03', '/a', '/a', true], ['G03', '/a', 'a', false], ['G03', 'a/', 'a/', true], ['G03', 'a/', 'a', false], ['G03', '', '', true], ['G03', '', 'a', false],
  ['G04', '[abc].txt', 'b.txt', true], ['G04', '[a-c]x', 'dx', false], ['G04', '[a-cx-z]1', 'y1', true],
  ['G05', '[!a-c]x', 'dx', true], ['G05', '[^a-c]x', 'bx', false], ['G05', 'a[!b]c', 'a/c', false],
  ['G06', '[]a]', ']', true], ['G06', '[]a]', 'a', true], ['G06', '[!]a]', 'b', true], ['G06', '[!]a]', ']', false],
  ['G07', '[-a]', '-', true], ['G07', '[a-]', '-', true], ['G07', '[a-]', 'b', false],
  ['G08', '[\\]]', ']', true], ['G08', '[a\\-z]', '-', true], ['G08', '[a\\-z]', 'm', false],
  ['G09', 'a[b', 'a[b', true], ['G09', '[', '[', true], ['G09', 'x[!', 'x[!', true],
  ['G10', '\\*', '*', true], ['G10', '\\*', 'a', false], ['G10', 'a\\?', 'a?', true], ['G10', '\\[x]', '[x]', true], ['G10', 'a\\\\b', 'a\\b', true], ['G10', 'end\\', 'end\\', true],
  ['G11', 'a**b', 'axyb', true], ['G11', 'a**b', 'ax/yb', false], ['G11', 'x/***', 'x/abc', true],
  ['G12', '{a,b}.js', 'b.js', true], ['G12', '{a,b}.js', 'c.js', false], ['G12', 'x{,y}', 'x', true], ['G12', 'x{,y}', 'xy', true],
  ['G13', '{a,{b,c}d}', 'cd', true], ['G13', '{a,{b,c}d}', 'c', false], ['G13', '{a,b}{1,2}', 'b2', true],
  ['G14', '{src,lib/**}/*.ts', 'lib/x/y/z.ts', true], ['G14', '{src,lib/**}/*.ts', 'src/x/z.ts', false],
  ['G15', '{a}', '{a}', true], ['G15', '{a}', 'a', false], ['G15', '{}', '{}', true], ['G15', 'a{b', 'a{b', true], ['G15', 'a{b,c', 'a{b,c', true],
  ['G16', '\\{a,b}', '{a,b}', true], ['G16', '\\{a,b}', 'a', false], ['G16', '{a\\,b,c}', 'a,b', true], ['G16', '{a\\,b,c}', 'a', false],
  ['G17', '[{,]x', ',x', true], ['G17', '[{,]x', '{x', true], ['G17', '[{,}]', '}', true],
  ['G18', 'a/**/b', 'a/b', true], ['G18', 'a/**/b', 'a/x/y/b', true], ['G18', 'a/**/b', 'a/x/y/c', false], ['G18', 'a/**', 'a', true], ['G18', 'a/**', 'a/x/y', true],
  ['G19', '**', '', true], ['G19', '**', 'a/b/c', true], ['G19', '**/x', 'x', true], ['G19', '**/*.md', 'docs/a/b.md', true],
  ['G20', '*.md', '.github.md', false], ['G20', '.*.md', '.github.md', true], ['G20', '\\.*', '.x', true], ['G20', '?x', '.x', false], ['G20', '[.]x', '.x', false],
  ['G21', 'a/**/b', 'a/.x/b', false], ['G21', '**', '.git/config', false], ['G21', '**/config', 'a/.git/config', false], ['G21', 'a/.x/**', 'a/.x/y', true],
  ['G22', '*.md', '.github.md', true, { dot: true }], ['G22', '**', '.git/config', true, { dot: true }], ['G22', 'a/**/b', 'a/.x/b', true, { dot: true }],
  ['G23', 'ABC', 'abc', false], ['G23', 'ABC', 'abc', true, { nocase: true }], ['G23', '[A-C]x', 'bX', true, { nocase: true }], ['G23', '*.JS', 'a.js', true, { nocase: true }],
  ['G24', 'a.b', 'aXb', false], ['G24', 'a+b(c)', 'a+b(c)', true], ['G24', '$^|', '$^|', true],
  ['G25', 'src/**/test/*.{js,mjs}', 'src/a/b/test/x.mjs', true], ['G25', 'src/**/test/*.{js,mjs}', 'src/test/.x.js', false],
]
for (const [id, pattern, path, want, opts] of cases) {
  test(id + ' ' + JSON.stringify(pattern) + ' ~ ' + JSON.stringify(path) + (opts ? ' ' + JSON.stringify(opts) : '') + ' -> ' + want, () => {
    assert.equal(match(pattern, path, opts), want)
  })
}
