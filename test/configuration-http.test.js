import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { apply } from '../index.js'

test('real HTTP dispatch uses the current session provider after overrides are cleared', async t => {
  const received = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: 'local HTTP fixture', results: [] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const values = { baseURL: '', apiKeyEnv: '', model: undefined }
  let tool
  const disposers = []
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'magpie-responses', settingsNs: 'models', settingsPath: ['magpieRoute'] },
        { provider: 'sub2api', settingsNs: 'models', settingsPath: ['sub2apiRoute'] },
        { provider: 'other-gateway', settingsNs: 'models', settingsPath: ['otherRoute'] },
      ],
      listModels: async () => assert.fail('Standalone search must not consult the chat model catalog'),
    },
    settings: { describe: () => [{ ns: 'models', value: {
      magpieRoute: { baseURL: `${origin}/magpie/v1`, apiKeyEnv: 'MAGPIE_TEST_KEY' },
      sub2apiRoute: { baseURL: `${origin}/sub2api/v1`, apiKeyEnv: 'SUB2API_TEST_KEY' },
      otherRoute: { baseURL: `${origin}/other/v1`, apiKeyEnv: 'OTHER_TEST_KEY' },
    } }] },
    credentials: { resolve: async ref => ({ value: {
      MAGPIE_TEST_KEY: 'fake-magpie-key', SUB2API_TEST_KEY: 'fake-sub2api-key',
      OTHER_TEST_KEY: 'fake-other-key', CUSTOM_TEST_KEY: 'fake-custom-key',
    }[ref] }) },
    tools: { register(definition) { tool = definition; return () => {} } },
    systemPrompt: { section: () => () => {} },
    spillStore: { saveText: async () => assert.fail('No spill expected') },
  }
  apply(ctx, { baseURL: { get: () => values.baseURL }, apiKeyEnv: { get: () => values.apiKeyEnv }, model: { get: () => values.model } })
  t.after(() => { while (disposers.length) disposers.pop()() })
  let provider = 'sub2api'
  const agent = { id: 'local-http-test', model: { current: () => ({ provider, model: 'chat-model' }) } }
  const exec = { agent, callId: 'local-call', signal: new AbortController().signal }
  await tool.execute({ query: 'default' }, exec)
  values.baseURL = `${origin}/custom/v1`
  await assert.rejects(tool.execute({ query: 'custom address without its own key' }, exec), /API KEY for the custom BASE_URL/)
  values.apiKeyEnv = 'CUSTOM_TEST_KEY'
  values.model = 'custom-direct-model'
  await tool.execute({ query: 'overridden' }, exec)
  values.model = 'sub2api/gpt-6.1-sol'
  await tool.execute({ query: 'explicit provider prefix' }, exec)
  values.baseURL = ''
  values.apiKeyEnv = ''
  values.model = ''
  provider = 'other-gateway'
  await tool.execute({ query: 'switched provider' }, exec)
  assert.deepEqual(received.map(req => [req.path, req.authorization, req.body.model, req.body.commands.search_query[0].q]), [
    ['/sub2api/v1/alpha/search', 'Bearer fake-sub2api-key', 'gpt-6.1-sol', 'default'],
    ['/custom/v1/alpha/search', 'Bearer fake-custom-key', 'custom-direct-model', 'overridden'],
    ['/custom/v1/alpha/search', 'Bearer fake-custom-key', 'sub2api/gpt-6.1-sol', 'explicit provider prefix'],
    ['/other/v1/alpha/search', 'Bearer fake-other-key', 'gpt-6.1-sol', 'switched provider'],
  ])
})
