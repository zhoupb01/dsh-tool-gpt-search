import {
  TIMEOUT_MS, TOOL_SCHEMA, OUTPUT_SCHEMA, GUIDANCE,
  validateParams, normalizeModel, requestSearch, boundResult, renderResult,
} from './search.js'
import { resolveTarget, snapshotOverrides } from './configuration.js'
export { Config, resolveTarget } from './configuration.js'

export const name = 'gpt-search'
export const inject = ['tools', 'llm', 'settings', 'credentials', 'spillStore', 'systemPrompt']

export function apply(ctx, config = {}) {
  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort())
  ctx.effect(() => ctx.systemPrompt.section({ name: 'gpt-search', order: 820, text: GUIDANCE }))
  ctx.effect(() => ctx.tools.register({
    ...TOOL_SCHEMA,
    timeoutMs: TIMEOUT_MS + 5000,
    isConcurrencySafe: () => true,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
      presentationMeta: (_args, value) => ({
        answer: value.output,
        sources: value.results.filter(source => /^https?:\/\//i.test(source.url ?? '')).map(source => ({
          url: source.url,
          ...(source.title === undefined ? {} : { title: source.title }),
          ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
        })),
        truncated: value.truncated,
      }),
    },
    async execute(args, exec) {
      const params = validateParams(args)
      const signal = AbortSignal.any([exec.signal, lifecycle.signal])
      signal.throwIfAborted()
      if (!exec.agent) throw new Error('gpt_search requires an active DSH session.')
      const overrides = snapshotOverrides(config)
      const model = normalizeModel(overrides.model)
      const target = await resolveTarget(ctx, overrides)
      signal.throwIfAborted()
      const full = await requestSearch({ params, target, model, sessionId: exec.agent.id, signal })
      signal.throwIfAborted()
      return boundResult(full, content => ctx.spillStore.saveText({
        owner: { sessionId: exec.agent.id },
        source: { kind: 'tool', toolName: 'gpt_search', callId: exec.callId, label: 'GPT search results' },
        suggestedName: 'gpt-search-results.json',
        content,
      }))
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: 'GPT search', rawInput: args }),
    presentResult: (_args, result) => {
      if (result.isError || !result.meta || !Array.isArray(result.meta.sources)) return undefined
      return { card: 'web', kind: 'search', title: 'GPT search', ...result.meta }
    },
  }))
}
