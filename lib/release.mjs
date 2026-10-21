import { readFileSync } from 'node:fs'

// The version recorded by release-please after a release PR is merged.
export function manifestVersion(manifestPath = '.release-please-manifest.json') {
  const versions = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version = versions['.']
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`${manifestPath} has no valid "." version`)
  return version
}

// A merged release PR's commit subject is "chore(release): <tagPrefix><version>" (release-please default title).
export function isReleaseCommit(subject, tag) {
  return subject.trim() === `chore(release): ${tag}` || subject.trim().startsWith(`chore(release): ${tag} (`)
}

// Changelog section for one version, without its heading; release notes body.
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r/g, '').split('\n')
  const escaped = version.replace(/[.+]/g, '\\$&')
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${escaped}\\]?(\\s|\\(|$)`).test(line))
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
}
