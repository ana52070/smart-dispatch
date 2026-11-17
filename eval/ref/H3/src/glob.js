// Reference glob matcher.

// Find the end index (exclusive) of a character class starting at s[i] === '['.
// Returns -1 when the class is not closed.
function classEnd(s, i) {
  let j = i + 1
  if (s[j] === '!' || s[j] === '^') j++
  if (s[j] === ']') j++
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === ']') return j + 1
  }
  return -1
}

// Expand braces. Literal braces/commas in the result are escaped.
function expand(s) {
  // find first top-level brace group that has a top-level comma
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '[') { const e = classEnd(s, i); if (e > 0) i = e - 1; continue }
    if (c !== '{') continue
    let depth = 0, close = -1
    const commas = []
    for (let j = i; j < s.length; j++) {
      const d = s[j]
      if (d === '\\') { j++; continue }
      if (d === '[') { const e = classEnd(s, j); if (e > 0) j = e - 1; continue }
      if (d === '{') depth++
      else if (d === '}') { depth--; if (depth === 0) { close = j; break } }
      else if (d === ',' && depth === 1) commas.push(j)
    }
    if (close < 0 || !commas.length) {
      // literal brace (unclosed, or no comma): escape it and keep scanning
      const rest = expand(s.slice(i + 1))
      return rest.map((r) => s.slice(0, i) + '\\{' + r)
    }
    const pre = s.slice(0, i), post = s.slice(close + 1)
    const parts = []
    let start = i + 1
    for (const k of commas) { parts.push(s.slice(start, k)); start = k + 1 }
    parts.push(s.slice(start, close))
    const posts = expand(post)
    const out = []
    for (const p of parts) for (const e of expand(p)) for (const q of posts) out.push(pre + e + q)
    return out
  }
  return [s]
}

const reEsc = (ch) => ch.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&')

// Compile one segment into { re, literalDot }.
function compileSegment(seg, nocase) {
  let re = '', literalDot = false
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    const first = i === 0
    if (c === '\\') {
      const n = i + 1 < seg.length ? seg[++i] : '\\'
      if (first && n === '.') literalDot = true
      re += reEsc(n)
    } else if (c === '*') {
      while (seg[i + 1] === '*') i++
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const e = classEnd(seg, i)
      if (e < 0) { re += '\\['; continue }
      let j = i + 1, neg = false
      if (seg[j] === '!' || seg[j] === '^') { neg = true; j++ }
      let body = ''
      const end = e - 1
      for (let k = j; k < end; k++) {
        let ch = seg[k]
        if (ch === '\\' && k + 1 < end) ch = seg[++k]
        else if (ch === '-' && k !== j && k + 1 < end) { body += '-'; continue }
        body += reEsc(ch)
      }
      re += '[' + (neg ? '^/' : '') + body + ']'
      i = e - 1
    } else {
      if (first && c === '.') literalDot = true
      re += reEsc(c)
    }
  }
  return { re: new RegExp('^' + re + '$', nocase ? 'i' : ''), literalDot }
}

function matchOne(pattern, path, { dot, nocase }) {
  const psegs = pattern.split('/')
  const segs = path.split('/')
  if (pattern === '') return path === ''
  const compiled = psegs.map((p) => (p === '**' ? null : compileSegment(p, nocase)))
  const memo = new Map()
  const segOk = (c, s) => {
    if (!dot && s[0] === '.' && !c.literalDot) return false
    return c.re.test(s)
  }
  const go = (i, j) => {
    const key = i * 100003 + j
    if (memo.has(key)) return memo.get(key)
    let r
    if (i === compiled.length) r = j === segs.length
    else if (compiled[i] === null) {
      r = go(i + 1, j)
      // empty path / trailing globstar: '**' may also match "nothing" when path is exhausted
      for (let k = j; !r && k < segs.length; k++) {
        if (!dot && segs[k][0] === '.') break
        r = go(i + 1, k + 1)
      }
    } else r = j < segs.length && segOk(compiled[i], segs[j]) && go(i + 1, j + 1)
    memo.set(key, r)
    return r
  }
  // globstar consuming zero segments: 'a/**' should match 'a'
  return go(0, 0) || (psegs.length >= 2 && psegs[psegs.length - 1] === '**' && matchOne(psegs.slice(0, -1).join('/'), path, { dot, nocase }))
    || (pattern === '**' && path === '')
}

export function match(pattern, path, { dot = false, nocase = false } = {}) {
  return expand(pattern).some((p) => matchOne(p, path, { dot, nocase }))
}
