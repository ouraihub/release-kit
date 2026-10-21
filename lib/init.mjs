import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, DEFAULTS } from './config.mjs'

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

// release-please extra-files entry for a version-bearing file, chosen by name and content.
export function versionFileEntry(path, content) {
  if (path.endsWith('.json')) return { type: 'json', path, jsonpath: '$.version' }
  if (path.endsWith('Cargo.lock')) return { type: 'toml', path, jsonpath: '$.package[?(!@.source)].version' }
  if (path.endsWith('Cargo.toml')) {
    const jsonpath = /^\[workspace\.package\][^[]*^version\s*=/m.test(content) ? '$.workspace.package.version' : '$.package.version'
    return { type: 'toml', path, jsonpath }
  }
  if (path.endsWith('.toml')) return { type: 'toml', path, jsonpath: '$.version' }
  return { type: 'generic', path }
}

export function releasePleaseConfig({ component, versionFiles, read }) {
  const sections = { feat: '新功能', fix: '问题修复', perf: '性能', revert: '回退' }
  return {
    $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
    'include-component-in-tag': Boolean(component),
    'tag-separator': '-',
    packages: {
      '.': {
        'release-type': 'simple',
        ...(component ? { component } : {}),
        'skip-github-release': true,
        'bump-minor-pre-major': true,
        'bump-patch-for-minor-pre-major': true,
        'changelog-sections': DEFAULTS.changelogTypes.map((type) => ({ type, section: sections[type] })),
        'extra-files': versionFiles.map((path) => versionFileEntry(path, read(path))),
      },
    },
  }
}

function writeNew(path, content, written) {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  written.push(path)
}

export function init({ root = process.cwd(), component = '', version, versionFiles, forbidden = [] }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('init needs --version x.y.z (the version already released)')
  for (const file of versionFiles) if (!existsSync(join(root, file))) throw new Error(`version file not found: ${file}`)
  const read = (file) => readFileSync(join(root, file), 'utf8')
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  const written = []
  writeNew(join(root, 'release-please-config.json'), json(releasePleaseConfig({ component, versionFiles, read })), written)
  writeNew(join(root, '.release-please-manifest.json'), json({ '.': version }), written)
  writeNew(join(root, CONFIG_FILE), json({ tagPrefix: component ? `${component}-v` : 'v', forbidden }), written)
  writeNew(join(root, '.github/workflows/release-kit.yml'), readFileSync(join(TEMPLATES, 'release-kit.yml'), 'utf8'), written)
  return written
}
