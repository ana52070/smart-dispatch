export class PatchError extends Error {
  constructor(message, hunk) { super('hunk ' + hunk + ': ' + message); this.name = 'PatchError'; this.hunk = hunk }
}

function splitSource(s) {
  const lines = []
  let i = 0
  while (i < s.length) {
    const j = s.indexOf('\n', i)
    if (j === -1) { lines.push({ text: s.slice(i), eol: '' }); break }
    if (j > i && s[j - 1] === '\r') lines.push({ text: s.slice(i, j - 1), eol: '\r\n' })
    else lines.push({ text: s.slice(i, j), eol: '\n' })
    i = j + 1
  }
  return lines
}

function parsePatch(patch) {
  const pl = patch.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (pl.length && pl[pl.length - 1] === '') pl.pop()
  const hunks = []
  let i = 0
  while (i < pl.length && !pl[i].startsWith('@@')) i++
  while (i < pl.length) {
    const no = hunks.length + 1
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(pl[i])
    if (!m) throw new PatchError('bad header', no)
    const a = +m[1], b = m[2] === undefined ? 1 : +m[2], d = m[4] === undefined ? 1 : +m[4]
    i++
    const items = []
    let oldN = 0, newN = 0
    while (oldN < b || newN < d) {
      if (i >= pl.length || pl[i].startsWith('@@')) throw new PatchError('truncated hunk', no)
      const l = pl[i++]
      const op = l === '' ? ' ' : l[0]
      if (op === '\\') {
        if (!items.length) throw new PatchError('marker first', no)
        items[items.length - 1].noEol = true
        continue
      }
      if (op !== ' ' && op !== '-' && op !== '+') throw new PatchError('bad line', no)
      items.push({ op, text: l.slice(1), noEol: false })
      if (op !== '+') oldN++
      if (op !== '-') newN++
    }
    while (i < pl.length && pl[i].startsWith('\\')) { items[items.length - 1].noEol = true; i++ }
    while (i < pl.length && !pl[i].startsWith('@@')) {
      const c = pl[i][0]
      if (pl[i] !== '' && (c === ' ' || c === '-' || c === '+')) throw new PatchError('hunk longer than header', no)
      i++
    }
    hunks.push({ a, b, items })
  }
  return hunks
}

export function applyPatch(source, patch, { fuzz = 0 } = {}) {
  const src = splitSource(source)
  const defEol = src.length && src[0].eol ? src[0].eol : '\n'
  const hunks = parsePatch(patch)
  const out = []
  const info = []
  let cursor = 0
  hunks.forEach((h, hi) => {
    const no = hi + 1
    const old = h.items.filter((x) => x.op !== '+')
    const neu = h.items.filter((x) => x.op !== '-')
    const expected = h.b === 0 ? h.a : h.a - 1
    let lead = 0; while (lead < h.items.length && h.items[lead].op === ' ') lead++
    let trail = 0; while (trail < h.items.length - lead && h.items[h.items.length - 1 - trail].op === ' ') trail++
    const matchAt = (p, s, e) => {
      if (p < cursor || p + old.length > src.length) return false
      for (let k = s; k < old.length - e; k++) {
        const line = src[p + k]
        if (line.text !== old[k].text) return false
        const isLastNoEol = p + k === src.length - 1 && line.eol === ''
        if (old[k].noEol !== isLastNoEol) return false
      }
      return true
    }
    let found = null
    for (let f = 0; f <= fuzz && !found; f++) {
      const s = Math.min(f, lead), e = Math.min(f, trail)
      const maxD = Math.max(expected - cursor, src.length - expected) + 1
      for (let dist = 0; dist <= maxD && !found; dist++) {
        for (const p of dist === 0 ? [expected] : [expected - dist, expected + dist]) {
          if (matchAt(p, s, e)) { found = { p, s, e, f }; break }
        }
      }
    }
    if (!found) throw new PatchError('does not apply', no)
    const { p, s, e, f } = found
    for (; cursor < p + s; cursor++) out.push(src[cursor])
    const repl = neu.slice(s, neu.length - e)
    // map context lines to their source lines to keep original eol
    let srcIdx = p + s
    let oi = s
    for (const item of h.items) {
      // walk items between skipped ranges
      void item
    }
    const body = h.items.slice()
    // drop skipped leading/trailing context items
    const kept = body.slice(s, body.length - e)
    for (const it of kept) {
      if (it.op === '-') { srcIdx++; oi++; continue }
      if (it.op === ' ') {
        const orig = src[srcIdx++]; oi++
        out.push({ text: it.text, eol: it.noEol ? '' : (orig.eol || defEol) })
      } else {
        out.push({ text: it.text, eol: it.noEol ? '' : defEol })
      }
    }
    void repl
    cursor = p + old.length - e
    info.push({ offset: p - expected, fuzz: f })
  })
  for (; cursor < src.length; cursor++) out.push(src[cursor])
  return { text: out.map((l) => l.text + l.eol).join(''), hunks: info }
}
