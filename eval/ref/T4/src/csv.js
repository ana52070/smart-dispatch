export class CsvError extends Error {
  constructor(message, line) { super(message + ' at line ' + line); this.line = line }
}

export function createParser({ delimiter = ',', onRow = () => {} } = {}) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || '"\r\n'.includes(delimiter)) throw new RangeError('bad delimiter')
  // states: START (field start), UNQ (unquoted), Q (in quotes), QQ (quote seen inside quotes), CR (after \r)
  let state = 'START', field = '', row = [], rowHasContent = false, line = 1, first = true, ended = false
  const endField = () => { row.push(field); field = '' }
  const endRow = () => {
    if (rowHasContent) onRow(row)
    row = []; rowHasContent = false
  }
  function step(ch) {
    if (state === 'CR') {
      state = 'START'
      if (ch === '\n') return
    }
    switch (state) {
      case 'START':
      case 'UNQ':
        if (ch === delimiter) { rowHasContent = true; endField(); state = 'START'; return }
        if (ch === '\n' || ch === '\r') {
          if (rowHasContent || field !== '' || state === 'UNQ') { rowHasContent = true; endField() } else { row = []; field = '' }
          endRow(); line++; state = ch === '\r' ? 'CR' : 'START'; return
        }
        if (ch === '"' && state === 'START') { state = 'Q'; rowHasContent = true; return }
        field += ch; state = 'UNQ'; rowHasContent = true; return
      case 'Q':
        if (ch === '"') { state = 'QQ'; return }
        if (ch === '\n') line++
        else if (ch === '\r') line++
        field += ch; return
      case 'QQ':
        if (ch === '"') { field += '"'; state = 'Q'; return }
        if (ch === delimiter) { endField(); state = 'START'; return }
        if (ch === '\n' || ch === '\r') { endField(); endRow(); line++; state = ch === '\r' ? 'CR' : 'START'; return }
        throw new CsvError('unexpected character after closing quote', line)
    }
  }
  let prevCrInQuotes = false
  return {
    push(chunk) {
      if (ended) throw new Error('parser already ended')
      let s = String(chunk)
      if (first && s.length) { if (s[0] === '﻿') s = s.slice(1); first = false }
      for (const ch of s) {
        // \r\n inside quotes counts as one physical line break
        if (state === 'Q' && ch === '\n' && prevCrInQuotes) { prevCrInQuotes = false; field += ch; continue }
        prevCrInQuotes = state === 'Q' && ch === '\r'
        step(ch)
      }
    },
    end() {
      if (ended) throw new Error('parser already ended')
      ended = true
      if (state === 'Q') throw new CsvError('unterminated quote', line)
      if (state === 'UNQ' || state === 'QQ' || rowHasContent) { endField(); rowHasContent = true; endRow() }
    },
  }
}

export function parse(text, options = {}) {
  const rows = []
  const p = createParser({ ...options, onRow: (r) => rows.push(r) })
  p.push(text)
  p.end()
  return rows
}
