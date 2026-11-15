import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

// Exercise the browser artifact's save operation, without rendering React or simulating a DOM.
let plugin
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  URL,
  window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => { assert.equal(name, 'react'); return {} })
  } } },
})
const { saveOverrides, normalizeBaseURL } = plugin
const newId = '11111111-2222-4333-8444-555555555555'
const newRef = 'GPT_SEARCH_API_KEY_11111111222243338444555555555555'
const oldRef = 'GPT_SEARCH_API_KEY_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ok = value => ({ ok: true, value })
const copy = value => JSON.parse(JSON.stringify(value))
function fixture(ref = 'MAGPIE_GATEWAY_KEY') {
  const calls = []
  const current = { ns: 'gpt-search', revision: 7, value: { baseURL: 'https://old.invalid/v1', apiKeyEnv: ref } }
  const remote = {
    credentials: {
      async set(ref, key) { calls.push(['set', ref, key]); return ok() },
      async unset(ref) { calls.push(['unset', ref]); return ok() },
    },
    settings: { async update(ns, patch, revision) {
      calls.push(['update', ns, copy(patch), revision])
      return ok({ ns, revision: revision + 1, value: { ...current.value, ...copy(patch) } })
    } },
  }
  return { calls, current, remote }
}

test('empty key input keeps the current reference and does not alter credentials', async () => {
  const { calls, current, remote } = fixture()
  const result = await saveOverrides(remote, current, { baseURL: ' https://new.invalid/v1/ ', apiKey: '', clearKey: false })
  assert.deepEqual(calls, [['update', 'gpt-search', { baseURL: 'https://new.invalid/v1', apiKeyEnv: 'MAGPIE_GATEWAY_KEY' }, 7]])
  assert.equal(result.updated.revision, 8)
})

test('a new key is staged under a new reference and activated together with BASE_URL', async () => {
  const { calls, current, remote } = fixture()
  await saveOverrides(remote, current, { baseURL: 'https://direct.invalid/v1', apiKey: 'fake-new-key', clearKey: false }, () => newId)
  assert.deepEqual(calls, [
    ['set', newRef, 'fake-new-key'],
    ['update', 'gpt-search', { baseURL: 'https://direct.invalid/v1', apiKeyEnv: newRef }, 7],
  ])
  assert.ok(!JSON.stringify(calls[1]).includes('fake-new-key'), 'ordinary settings never contain API key material')
})

test('restoring defaults clears both references without deleting a shared provider key', async () => {
  const { calls, current, remote } = fixture()
  await saveOverrides(remote, current, { baseURL: '', apiKey: '', clearKey: true })
  assert.deepEqual(calls, [['update', 'gpt-search', { baseURL: '', apiKeyEnv: '' }, 7]])
})

test('old plugin-owned credentials are removed only after the new settings commit', async () => {
  const { calls, current, remote } = fixture(oldRef)
  const result = await saveOverrides(remote, current, { baseURL: 'https://direct.invalid/v1', apiKey: 'fake-new-key', clearKey: false }, () => newId)
  assert.deepEqual(calls.map(call => call[0]), ['set', 'update', 'unset'])
  assert.deepEqual(calls[2], ['unset', oldRef])
  assert.equal(result.cleanupWarning, false)
})

test('a known stale-revision rejection removes only the unused staged key', async () => {
  const { calls, current, remote } = fixture(oldRef)
  remote.settings.update = async () => ({ ok: false, error: { code: 'settings/conflict', message: 'rejected' } })
  await assert.rejects(saveOverrides(remote, current, { baseURL: 'https://direct.invalid/v1', apiKey: 'fake-new-key', clearKey: false }, () => newId), /REMOTE_REJECTED/)
  assert.deepEqual(calls, [['set', newRef, 'fake-new-key'], ['unset', newRef]])
})

test('a lost settings response never deletes the key that might already be active', async () => {
  const { calls, current, remote } = fixture(oldRef)
  remote.settings.update = async () => { throw new Error('Connection lost after possible commit') }
  await assert.rejects(saveOverrides(remote, current, { baseURL: 'https://direct.invalid/v1', apiKey: 'fake-new-key', clearKey: false }, () => newId), /Connection lost/)
  assert.deepEqual(calls, [['set', newRef, 'fake-new-key']])
})

test('failed credential writes cannot commit settings or erase the existing credential', async () => {
  const { calls, current, remote } = fixture(oldRef)
  remote.credentials.set = async () => ({ ok: false, error: { message: 'fake-new-key' } })
  await assert.rejects(saveOverrides(remote, current, { baseURL: 'https://direct.invalid/v1', apiKey: 'fake-new-key', clearKey: false }, () => newId), error => {
    assert.equal(error.message, 'REMOTE_REJECTED')
    return true
  })
  assert.deepEqual(calls, [['unset', newRef]])
})

test('invalid addresses fail before any write and blank addresses restore defaults', async () => {
  const { calls, current, remote } = fixture()
  for (const baseURL of ['not a URL', 'ftp://invalid/v1', 'https://user:password@invalid/v1', 'https://invalid/v1?key=secret', 'https://invalid/v1#fragment']) {
    await assert.rejects(saveOverrides(remote, current, { baseURL, apiKey: 'fake-key', clearKey: false }), /INVALID_URL/)
  }
  assert.deepEqual(calls, [])
  assert.equal(normalizeBaseURL(' \t '), '')
  assert.equal(normalizeBaseURL(' http://127.0.0.1:3425/v1/// '), 'http://127.0.0.1:3425/v1')
})

test('a cleanup failure reports a saved configuration rather than retrying its write', async () => {
  const { current, remote } = fixture(oldRef)
  remote.credentials.unset = async () => ({ ok: false, error: { code: 'unavailable' } })
  const result = await saveOverrides(remote, current, { baseURL: '', apiKey: '', clearKey: true })
  assert.equal(result.updated.value.apiKeyEnv, '')
  assert.equal(result.cleanupWarning, true)
})

test('saving an explicit model preserves its optional provider prefix and the existing URL and key', async t => {
  for (const model of ['custom-search-model', 'sub2api/gpt-6.1-sol']) {
    await t.test(model, async () => {
      const { calls, current, remote } = fixture(oldRef)
      current.value.model = 'previous-model'
      const result = await saveOverrides(remote, current, { baseURL: current.value.baseURL, apiKey: '', clearKey: false, model })
      assert.deepEqual(calls, [['update', 'gpt-search', { baseURL: 'https://old.invalid/v1', apiKeyEnv: oldRef, model }, 7]])
      assert.deepEqual(copy(result.updated.value), { baseURL: 'https://old.invalid/v1', apiKeyEnv: oldRef, model })
      assert.equal(current.value.model, 'previous-model', 'editing must not mutate the loaded settings snapshot')
    })
  }
})

test('a blank model resets only model selection to gpt-6.1-sol without erasing URL or key overrides', async t => {
  for (const model of ['', ' \t ']) {
    await t.test(model ? 'whitespace' : 'empty', async () => {
      const { calls, current, remote } = fixture(oldRef)
      current.value.model = 'previous-model'
      const result = await saveOverrides(remote, current, { baseURL: current.value.baseURL, apiKey: '', clearKey: false, model })
      assert.deepEqual(calls, [['update', 'gpt-search', { baseURL: 'https://old.invalid/v1', apiKeyEnv: oldRef, model: 'gpt-6.1-sol' }, 7]])
      assert.equal(result.updated.value.model, 'gpt-6.1-sol')
      assert.equal(result.updated.value.apiKeyEnv, oldRef)
    })
  }
})

test('older save callers that omit model leave the existing model unchanged', async () => {
  const { calls, current, remote } = fixture(oldRef)
  current.value.model = 'custom/preserved-model'
  const result = await saveOverrides(remote, current, { baseURL: current.value.baseURL, apiKey: '', clearKey: false })
  assert.equal(Object.hasOwn(calls[0][2], 'model'), false)
  assert.equal(result.updated.value.model, 'custom/preserved-model')
  assert.equal(result.updated.value.baseURL, current.value.baseURL)
  assert.equal(result.updated.value.apiKeyEnv, oldRef)
})

test('invalid model drafts fail before any settings or credential writes', async () => {
  const { calls, current, remote } = fixture(oldRef)
  for (const model of ['two models', 'line\nbreak', 'a'.repeat(201)]) {
    await assert.rejects(saveOverrides(remote, current, { baseURL: current.value.baseURL, apiKey: 'fake-new-key', clearKey: false, model }), /INVALID_MODEL/)
  }
  assert.deepEqual(calls, [])
})
