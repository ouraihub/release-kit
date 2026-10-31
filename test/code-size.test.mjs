import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../bin/release-kit.mjs', import.meta.url))

test('check enforces language widths, total physical lines and Unicode counts',
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'code-size-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const git = (...args) => execFileSync('git', args,
      { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    git('config', 'core.autocrlf', 'false')
    const write = (file, text) => writeFileSync(join(dir, file), text)
    const check = () => spawnSync(process.execPath,
      [cli, 'check', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    const cases = [['a.ts', 80], ['b.rs', 100], ['c.py', 79],
      ['d.svelte', 80], ['e.tsx', 80], ['f.mts', 80], ['g.cts', 80],
      ['h.pyi', 79], ['decl.d.ts', 80]]
    for (const [file, width] of cases) write(file, 'x'.repeat(width) + '\r\n')
    write('lines.ts', '\uFEFF' + '// line\r\n'.repeat(500))
    write('unicode.ts', '😀'.repeat(80) + '\n')
    write('tabs.py', '\t' + 'x'.repeat(75) + '\n')
    write('empty.ts', '')
    git('add', '.')
    git('commit', '-qm', 'test: boundaries')
    let result = check()
    assert.equal(result.status, 0, result.stderr)
    for (const [file, width] of cases) write(file, 'x'.repeat(width + 1))
    write('lines.ts', '// line\n'.repeat(501))
    write('unicode.ts', '😀'.repeat(81))
    write('tabs.py', '\t' + 'x'.repeat(76))
    write('d.svelte', '<script>\n</script>\n' + '\n'.repeat(499))
    // Tracked files are checked from the worktree, not only the last commit.
    result = check()
    assert.equal(result.status, 1)
    for (const [file, width] of cases.filter(([file]) => file !== 'd.svelte')) {
      assert.ok(result.stderr.includes(
        `${file}:1: ${width + 1} columns > ${width}`), result.stderr)
    }
    assert.match(result.stderr, /lines.ts:501: 501 lines > 500/)
    assert.match(result.stderr, /d.svelte:501: 501 lines > 500/)
    assert.match(result.stderr, /unicode.ts:1: 81 columns > 80/)
    assert.match(result.stderr, /tabs.py:1: 80 columns > 79/)
  })
