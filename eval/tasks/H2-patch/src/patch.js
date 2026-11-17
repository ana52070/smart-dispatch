// Naive patch applier: trusts line numbers, ignores context. See README.md.
export class PatchError extends Error {}

export function applyPatch(source, patch) {
  const lines = source.split('\n')
  const out = []
  let cursor = 0
  const hunks = []
  const plines = patch.split('\n')
  for (let i = 0; i < plines.length; i++) {
    const m = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/.exec(plines[i])
    if (!m) continue
    const start = Number(m[1]) - 1
    while (cursor < start) out.push(lines[cursor++])
    for (i++; i < plines.length && !plines[i].startsWith('@@'); i++) {
      const l = plines[i]
      if (l[0] === ' ') { out.push(lines[cursor++]) }
      else if (l[0] === '-') cursor++
      else if (l[0] === '+') out.push(l.slice(1))
    }
    i--
    hunks.push({ offset: 0, fuzz: 0 })
  }
  while (cursor < lines.length) out.push(lines[cursor++])
  return { text: out.join('\n'), hunks }
}
