import { execFileSync } from 'node:child_process'
import { manifestVersion } from './release.mjs'

const MANIFEST = '.release-please-manifest.json'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()

function versionAt(ref) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${MANIFEST}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))['.'] ?? null
  } catch {
    return null
  }
}

// Decides whether HEAD is a merged release PR that still needs its tag.
export function planTag({ tagPrefix, head = 'HEAD' }) {
  const version = manifestVersion(MANIFEST)
  const tag = `${tagPrefix}${version}`
  const sha = git('rev-parse', head)
  if (versionAt(`${head}^`) === version) return { action: 'skip', reason: `${MANIFEST} unchanged in ${sha.slice(0, 7)}`, tag, version, sha }
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)
  if (remote) {
    const tagged = remote.split(/\s+/)[0]
    if (tagged !== sha) throw new Error(`${tag} already points at ${tagged.slice(0, 7)}, not ${sha.slice(0, 7)}`)
    return { action: 'exists', tag, version, sha }
  }
  return { action: 'create', tag, version, sha }
}

// Pushes the tag through the API (a token push triggers tag workflows; GITHUB_TOKEN would not),
// then marks the release PR as tagged so release-please opens the next one.
export function createTag({ tag, sha }, repo = process.env.GITHUB_REPOSITORY) {
  gh('api', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`)
  const prs = JSON.parse(gh('api', `repos/${repo}/commits/${sha}/pulls`, '--jq', '[.[] | select(.labels[].name == "autorelease: pending") | .number]'))
  for (const number of prs) {
    gh('api', '-X', 'DELETE', `repos/${repo}/issues/${number}/labels/autorelease:%20pending`)
    gh('api', `repos/${repo}/issues/${number}/labels`, '-f', 'labels[]=autorelease: tagged')
  }
  return prs
}
