// Very rough glob matcher. See README.md for the required behaviour.
export function match(pattern, path) {
  const re = pattern
    .replace(/[.+^$()|]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^' + re + '$').test(path)
}
