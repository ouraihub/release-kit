import { LIMITS, parseVerdict } from './review-findings.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const type = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const finishReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call']

export function responseLocation(phase, location = {}) {
  return {
    phase: ['scan', 'recheck'].includes(phase) ? phase : 'unknown',
    scope: ['batch', 'consistency'].includes(location.scope) ? location.scope : null,
    batch: count(location.batch),
    candidate: count(location.candidateId),
    round: count(location.round),
  }
}

// Only fixed categories, booleans and counts cross this diagnostic boundary.
// Never include model text, arbitrary keys/IDs, headers, URLs or parser errors.
export function readReviewResponse(envelope, phase, location = {}) {
  const choice = Array.isArray(envelope?.choices) ? envelope.choices[0] : undefined
  const message = object(choice?.message) ? choice.message : undefined
  const content = message?.content
  const diagnostic = {
    ...responseLocation(phase, location),
    choices: Array.isArray(envelope?.choices) ? envelope.choices.length : null,
    finishReason: finishReasons.includes(choice?.finish_reason) ? choice.finish_reason : 'unknown',
    refusal: message?.refusal !== undefined && message.refusal !== null,
    contentType: type(content),
    contentChars: typeof content === 'string' ? content.length : null,
    completionTokens: count(envelope?.usage?.completion_tokens),
  }
  let reason
  let value = null
  if (!object(envelope)) reason = 'envelope_type'
  else if (!choice) reason = 'missing_choice'
  else if (!message) reason = 'missing_message'
  else if (diagnostic.refusal) reason = 'refusal'
  else if (['length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason)) reason = 'unfinished_completion'
  else if (typeof content !== 'string') reason = 'content_type'
  else if (!content.trim()) reason = 'empty_content'
  else if (content.length > LIMITS.responseChars) reason = 'content_limit'
  else {
    try { JSON.parse(content) } catch { reason = 'content_json' }
    if (!reason) {
      value = parseVerdict(content, phase)
      if (!value) reason = 'verdict_schema'
    }
  }
  if (reason) {
    throw new Error(`Invalid structured review response; failing closed. Diagnostics: ${JSON.stringify({ ...diagnostic, reason })}`)
  }
  return value
}
