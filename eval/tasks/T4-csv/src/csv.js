// Streaming CSV parser — see README.md for the full specification.

export class CsvError extends Error {}

export function createParser({ delimiter = ',', onRow } = {}) {
  throw new Error('not implemented')
}

export function parse(text, options = {}) {
  const rows = []
  const p = createParser({ ...options, onRow: (r) => rows.push(r) })
  p.push(text)
  p.end()
  return rows
}
