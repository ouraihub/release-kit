import { execFileSync } from 'node:child_process'
import { forbiddenPattern } from './config.mjs'

// Scans tracked files for forbidden words. Comments, doc comments and identifiers all count:
// the rule is "provenance lives in design docs", so excluded paths are the only escape hatch.
export function scanTree(config) {
  const pattern = forbiddenPattern(config.forbidden)
  if (!pattern) return []
  const excludes = config.ignore.map((spec) => `:(exclude,glob)**/${spec.replace(/^\*\*\//, '')}`)
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-n', '-I', '-i', '-E', pattern.source, '--', '.', ...excludes], { encoding: 'utf8', maxBuffer: 1 << 26 })
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [file, lineNo, ...text] = line.split(':')
      return { file, line: Number(lineNo), word: text.join(':').match(pattern)?.[0] ?? '' }
    })
}
