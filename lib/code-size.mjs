import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const MAX_LINES = 500
const WIDTHS = { '.ts': 80, '.tsx': 80, '.mts': 80, '.cts': 80,
  '.rs': 100, '.py': 79, '.pyi': 79, '.svelte': 80 }

export function scanCodeSize() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'],
    { encoding: 'utf8' }).trim()
  const files = execFileSync('git', ['ls-files', '--cached', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)
  const problems = []
  for (const file of new Set(files)) {
    const limit = WIDTHS[extname(file)]
    if (!limit) continue
    const path = join(root, file)
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error.code === 'ENOENT') continue // Tracked deletion in the worktree.
      throw error
    }
    if (!stat.isFile()) {
      problems.push({ file, line: 1, message: 'source must be a regular file' })
      continue
    }
    const content = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const lines = content ? content.split(/\r\n|\n|\r/) : []
    if (content.endsWith('\n') || content.endsWith('\r')) lines.pop()
    if (lines.length > MAX_LINES) {
      problems.push({ file, line: MAX_LINES + 1,
        message: `${lines.length} lines > ${MAX_LINES}; split by responsibility` })
    }
    for (const [index, text] of lines.entries()) {
      let width = 0
      for (const char of text) {
        width += char === '\t' ? 4 - width % 4 : 1
      }
      if (width > limit) problems.push({ file, line: index + 1,
        message: `${width} columns > ${limit}; wrap without changing behavior` })
    }
  }
  return problems
}
