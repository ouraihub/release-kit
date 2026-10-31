import { execFileSync } from 'node:child_process'
import { blobReader, LIMITS, validSha } from './review-findings.mjs'
import { discoveryInputs, isSensitive, prChanges, reviewBatches, systemPrompt } from './review.mjs'

// Reserve per request for final PR metadata, trusted permission policy and follow-up context.
const RESERVE_CHARS = 50_000

export function reviewSize({ base, head = 'HEAD', title = '', body = '' }) {
  if (!base) throw new Error('review-size requires --base <PR target ref>, not the feature branch upstream')
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const root = run(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  const git = (...args) => run(root, ...args)
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit all intended changes first; review-size checks committed base...head, not staged or untracked files')
  const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim()
  const baseSha = resolve(base), headSha = resolve(head)
  const mergeBaseSha = git('merge-base', '--all', baseSha, headSha).trim()
  if (!validSha(mergeBaseSha)) throw new Error('Missing or ambiguous PR merge base')
  const { files, diff } = prChanges(git, baseSha, headSha)
  if (!diff) throw new Error('No changes between PR base and head')
  if (/^(?:Binary files |GIT binary patch)/m.test(diff)) throw new Error('Binary changes cannot be completely reviewed; splitting alone will not fix this')
  const rulesFile = 'AGENTS.md'
  const rules = blobReader(git, { base: baseSha, head: headSha })({ path: rulesFile, side: 'base', startLine: null, endLine: null }, true)?.content ?? ''
  const system = systemPrompt(rules, files.filter(isSensitive))
  const manifest = { title, body, headSha, baseSha, mergeBaseSha, files, rulesFile, codeBase: 'side base means mergeBaseSha; rule citations use target baseSha, never mergeBaseSha' }
  const batches = reviewBatches(diff)
  const requests = [...discoveryInputs(manifest, batches)].map((payload) => ({
    scope: payload.scope,
    batch: payload.batch,
    chars: system.length + JSON.stringify({ phase: 'scan', ...payload, context: [], previous: [] }).length,
    limit: payload.scope === 'consistency' ? LIMITS.consistencyChars : LIMITS.requestChars,
  }))
  const totalChars = requests.reduce((sum, request) => sum + request.chars, 0)
  const reservedChars = RESERVE_CHARS * requests.length
  const reasons = requests.filter((request) => request.chars + RESERVE_CHARS > request.limit)
    .map((request) => `${request.scope}${request.batch ? ` ${request.batch}` : ''}: ${request.chars} + ${RESERVE_CHARS} reserve > ${request.limit}`)
  if (totalChars + reservedChars > LIMITS.inputChars) reasons.push(`cumulative: ${totalChars} + ${reservedChars} reserve > ${LIMITS.inputChars}`)
  const largest = diff.split(/(?=^diff --git )/m).map((patch) => ({ header: patch.split('\n', 1)[0], chars: patch.length }))
    .sort((a, b) => b.chars - a.chars).slice(0, 5)
  return { fits: reasons.length === 0, baseSha, headSha, files: files.length, diffChars: diff.length, batches: batches.length, requests, totalChars, reservedChars, reasons, largest }
}

export function formatReviewSize(result) {
  return [
    `release-kit: ${result.fits ? 'FITS discovery budget' : 'SPLIT PR before pushing'}`,
    `base ${result.baseSha}; head ${result.headSha}`,
    `${result.files} files; ${result.diffChars} diff chars; ${result.batches} batches`,
    ...result.requests.map((request) => `${request.scope}${request.batch ? ` ${request.batch}` : ''}: ${request.chars}/${request.limit} chars (+${RESERVE_CHARS} reserve)`),
    `cumulative: ${result.totalChars} + ${result.reservedChars} reserve / ${LIMITS.inputChars}`,
    ...result.reasons,
    'Largest file patches:',
    ...result.largest.map((patch) => `  ${patch.chars} chars: ${patch.header}`),
    'If over budget, split by independently testable features; each PR must pass CI. More commits in the same PR do not reduce its diff.',
    'Dependent PRs: merge the prerequisite first, or target its branch and recheck after retargeting. Never separate an API change from its required callers/tests.',
    'Local estimate only: no AI/network calls. FITS is not approval; model capacity, further context and candidate rechecks can still exceed limits.',
  ].join('\n')
}
