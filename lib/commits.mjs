import { execFileSync } from 'node:child_process'
import { NOISE, forbiddenPattern } from './config.mjs'

// Returns the problems in one commit message; empty means it passes.
export function lintMessage(message, config) {
  const [subject = '', ...rest] = message.replace(/\r/g, '').split('\n')
  if (/^(Merge|Revert ")/.test(subject)) return []
  const problems = []
  const types = [...config.changelogTypes, ...config.otherTypes].join('|')
  if (!new RegExp(`^(${types})(\\([a-z0-9-]+\\))?!?: \\S`).test(subject))
    problems.push(`subject must be "<type>(<scope>): <summary>" with type in ${types.replaceAll('|', ', ')}`)
  if ([...subject].length > config.maxSubject) problems.push(`subject is ${[...subject].length} chars, max ${config.maxSubject}`)
  if (/[.。]$/.test(subject)) problems.push('subject must not end with a period')
  const body = rest.filter((line) => line.trim() && !/^[A-Za-z-]+: /.test(line))
  if (body.length > config.maxBodyLines) problems.push(`body is ${body.length} lines, max ${config.maxBodyLines}: explain why, not what the diff shows`)
  for (const pattern of NOISE) if (pattern.test(message)) problems.push(`remove session notes (${pattern.source})`)
  const forbidden = forbiddenPattern(config.forbidden)
  const hit = forbidden && message.match(forbidden)
  if (hit) problems.push(`mentions reference project "${hit[0]}"`)
  return problems
}

// Commits after `base` (exclusive); without a base, only HEAD.
export function commitsSince(base) {
  const range = base ? [`${base}..HEAD`] : ['-1', 'HEAD']
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%h%x1f%B%x1e', ...range], { encoding: 'utf8' })
  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, message] = entry.split('\x1f')
      return { sha, message: message.trim() }
    })
}
