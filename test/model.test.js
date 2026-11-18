import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { normalizeModel, requestSearch } from '../search.js'
import { Config } from '../configuration.js'
import { apply } from '../index.js'

const target = { baseURL: 'https://search.invalid/v1', apiKey: 'fake-search-key' }
const response = () => ({ ok: true, json: async () => ({ output: 'offline result', results: [] }) })
const exec = { agent: { id: 'model-test', model: { current: () => ({ provider: 'sub2api', model: 'chat-model' }) } }, callId: 'model-call', signal: new AbortController().signal }

beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected remote network request'))
})

function fixture(t, initial = {}) {
  const values = { baseURL: '', apiKeyEnv: '', model: undefined, ...initial }
  const requests = []
  const refs = []
  const keys = new Map([['DEFAULT_KEY', 'fake-default-key'], ['FIRST_KEY', 'fake-first-key'], ['SECOND_KEY', 'fake-second-key']])
  const ctx = {
    effect(register) { const dispose = register(); t.after(dispose); return dispose },
    llm: {
      listConfigurableProviders: () => [{ provider: 'sub2api', settingsNs: 'models', settingsPath: ['route'] }],
      listModels: async () => assert.fail('The search model must be independent of chat model discovery'),
    },
    settings: { describe: () => [{ ns: 'models', value: { route: { baseURL: 'https://default.invalid/v1', apiKeyEnv: 'DEFAULT_KEY' } } }] },
    credentials: { resolve: async ref => { refs.push(ref); return { value: keys.get(ref) } } },
    systemPrompt: { section: () => () => {} },
    spillStore: { saveText: async () => assert.fail('No spill expected') },
    tools: { register(definition) { tool = definition; return () => {} } },
  }
  let tool
  apply(ctx, {
    baseURL: { get: () => values.baseURL },
    apiKeyEnv: { get: () => values.apiKeyEnv },
    model: { get: () => values.model },
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) })
    return response()
  })
  return { ctx, values, requests, refs, tool }
}

test('standalone search defaults to the unprefixed gpt-6.1-sol model and preserves explicitly selected names', async t => {
  const cases = [
    ['omitted model', undefined, 'gpt-6.1-sol'],
    ['empty model', '', 'gpt-6.1-sol'],
    ['blank model', ' \t\n ', 'gpt-6.1-sol'],
    ['direct custom model', 'my-search-model', 'my-search-model'],
    ['explicit provider prefix', 'sub2api/gpt-6.1-sol', 'sub2api/gpt-6.1-sol'],
    ['outer whitespace', '  other/provider-model  ', 'other/provider-model'],
  ]
  for (const [name, model, expected] of cases) {
    await t.test(name, async () => {
      let sent
      await requestSearch({ params: { query: 'model routing' }, target, model, sessionId: 'model-routing', fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body)
        return response()
      } })
      assert.equal(sent.model, expected)
      assert.equal(sent.id, 'model-routing')
      assert.deepEqual(sent.commands, { search_query: [{ q: 'model routing' }] })
    })
  }
})

test('invalid model values fail before the transport is called', async t => {
  const invalid = [null, 42, true, {}, [], 'two models', 'line\nbreak', 'tab\tmodel', 'a'.repeat(201)]
  for (const [index, model] of invalid.entries()) {
    await t.test(`invalid model ${index}`, async () => {
      let requests = 0
      await assert.rejects(requestSearch({ params: { query: 'must not dispatch' }, target, model, fetchImpl: async () => {
        requests++
        return response()
      } }), /model/i)
      assert.equal(requests, 0)
    })
  }
  assert.equal(normalizeModel('a'.repeat(200)), 'a'.repeat(200))
})

test('Config supports a blank model reset and rejects malformed model names before activation', () => {
  assert.equal(Config({}).model.get(), 'gpt-6.1-sol')
  assert.equal(Config({ model: '' }).model.get(), '')
  assert.equal(Config({ model: 'custom/prefixed-model' }).model.get(), 'custom/prefixed-model')
  for (const model of ['two models', 'line\nbreak', 'a'.repeat(201), 42, []]) {
    assert.throws(() => Config({ model }), /model/)
  }
})

test('the default search model is usable without any matching chat catalog entry', async t => {
  const { tool, requests } = fixture(t)
  await tool.execute({ query: 'default model' }, exec)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.model, 'gpt-6.1-sol')
  assert.equal(requests[0].url, 'https://default.invalid/v1/alpha/search')
  assert.equal(requests[0].authorization, 'Bearer fake-default-key')
})

test('invalid live model edits fail before credentials or HTTP and can be corrected without remounting', async t => {
  const { tool, values, requests, refs } = fixture(t, { model: 'invalid model' })
  await assert.rejects(tool.execute({ query: 'invalid configured model' }, exec), /model/i)
  assert.deepEqual(refs, [])
  assert.deepEqual(requests, [])
  values.model = 'corrected-model'
  await tool.execute({ query: 'corrected configured model' }, exec)
  assert.equal(requests[0].body.model, 'corrected-model')
})

test('live model edits affect the next call and clearing restores the direct default without changing URL or key', async t => {
  const { tool, values, requests } = fixture(t, { baseURL: 'https://custom.invalid/v1', apiKeyEnv: 'FIRST_KEY' })
  for (const model of [undefined, 'custom-model', 'sub2api/gpt-6.1-sol', '', ' \t ']) {
    values.model = model
    await tool.execute({ query: 'live model selection' }, exec)
  }
  assert.deepEqual(requests.map(request => request.body.model), ['gpt-6.1-sol', 'custom-model', 'sub2api/gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol'])
  assert.ok(requests.every(request => request.url === 'https://custom.invalid/v1/alpha/search'))
  assert.ok(requests.every(request => request.authorization === 'Bearer fake-first-key'))
})

test('model, endpoint, and key reference are snapshotted together before asynchronous credential resolution', async t => {
  const { tool, ctx, values, requests } = fixture(t, { baseURL: 'https://first.invalid/v1', apiKeyEnv: 'FIRST_KEY', model: 'first-model' })
  let finishLookup
  ctx.credentials.resolve = ref => {
    if (ref === 'FIRST_KEY') return new Promise(resolve => { finishLookup = resolve })
    assert.equal(ref, 'SECOND_KEY')
    return Promise.resolve({ value: 'fake-second-key' })
  }
  const first = tool.execute({ query: 'first' }, exec)
  assert.equal(typeof finishLookup, 'function')
  values.model = 'other/second-model'
  values.baseURL = 'https://second.invalid/v1'
  values.apiKeyEnv = 'SECOND_KEY'
  finishLookup({ value: 'fake-first-key' })
  await first
  await tool.execute({ query: 'second' }, exec)
  assert.deepEqual(requests.map(request => [request.url, request.authorization, request.body.model]), [
    ['https://first.invalid/v1/alpha/search', 'Bearer fake-first-key', 'first-model'],
    ['https://second.invalid/v1/alpha/search', 'Bearer fake-second-key', 'other/second-model'],
  ])
})
