const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parse(v) {
  const m = RE.exec(String(v).trim())
  if (!m) throw new TypeError('invalid version: ' + v)
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

export function compare(a, b) {
  const x = parse(a), y = parse(b)
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  const p = x.pre.join('.'), q = y.pre.join('.')
  if (p === q) return 0
  return p < q ? -1 : 1
}

export function satisfies(version, range) {
  throw new Error('not implemented')
}
