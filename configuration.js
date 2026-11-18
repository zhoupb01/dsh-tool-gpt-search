import z from '@deepseek-ai/schemastery'
import { DEFAULT_MODEL, searchEndpoint } from './search.js'

export const API_KEY_REF = 'GPT_SEARCH_API_KEY'

export const Config = z.object({
  model: z.string().pattern(/^\S{0,200}$/).default(DEFAULT_MODEL)
    .description('Search model sent to the endpoint as written. Empty uses gpt-6.1-sol.').volatile(),
  baseURL: z.string().pattern(/^(?:https?:\/\/[^\s/?#@]+(?:\/[^?#\s]*)?)?$/i).default('').description('BASE_URL override. Leave empty to use the current chat provider. A different address requires its own API key.').volatile(),
  apiKeyEnv: z.string().pattern(/^(?:[A-Z_][A-Z0-9_]*)?$/).role('credential-ref').default('')
    .description('Credential reference for the independent API key. The current chat provider key applies only at its own search address.').volatile(),
})

const valueOf = value => typeof value?.get === 'function' ? value.get() : value

// Snapshot both overrides before awaiting credentials so a settings edit cannot mix calls.
export function snapshotOverrides(config = {}) {
  return { baseURL: valueOf(config.baseURL), apiKeyEnv: valueOf(config.apiKeyEnv), model: valueOf(config.model) }
}

export async function resolveTarget(ctx, overrides, provider) {
  const baseOverride = typeof overrides.baseURL === 'string' ? overrides.baseURL.trim() : ''
  const overrideEndpoint = baseOverride && searchEndpoint(baseOverride).href
  const keyOverrideRef = overrides.apiKeyEnv
  const route = provider && ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
  const form = route && ctx.settings?.describe({ redactSecrets: true }).find(entry => entry.ns === route.settingsNs)
  let profile = form?.value
  for (const segment of route?.settingsPath ?? []) profile = profile?.[segment]
  const defaultBaseURL = typeof profile?.baseURL === 'string' ? profile.baseURL.trim() : ''
  const defaultKeyRef = profile?.apiKeyEnv
  const customKey = keyOverrideRef ? (await ctx.credentials.resolve(keyOverrideRef))?.value : undefined
  if (baseOverride && customKey) return { baseURL: baseOverride, apiKey: customKey }
  if (!route || route.error) {
    throw new Error('Configure the current session provider in Settings → Models, or set both BASE_URL and API KEY in Plugins → GPT search.')
  }
  const baseURL = baseOverride || defaultBaseURL
  if (!baseURL) {
    throw new Error('Configure a base URL in Plugins → GPT search or Settings → Models before using gpt_search.')
  }
  // The provider credential can be used only at its own search endpoint.
  if (overrideEndpoint && (!defaultBaseURL || overrideEndpoint !== searchEndpoint(defaultBaseURL).href)) {
    throw new Error('Set an API KEY for the custom BASE_URL in Plugins → GPT search.')
  }
  if (!customKey && (typeof defaultKeyRef !== 'string' || !defaultKeyRef)) {
    throw new Error('Configure an API key in Plugins → GPT search or Settings → Models before using gpt_search.')
  }
  const apiKey = customKey || (await ctx.credentials.resolve(defaultKeyRef))?.value
  if (!apiKey) throw new Error('No API key configured. Update it in Plugins → GPT search or Settings → Models.')
  // Search model selection is independent of the chat provider's model catalog.
  return { baseURL, apiKey }
}
