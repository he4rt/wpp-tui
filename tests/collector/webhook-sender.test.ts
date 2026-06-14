import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { signPayload, computeBackoffMs, classifyStatus, sendOnce } from '../../src/collector/webhook-sender.js'

test('signPayload assina event_id + corpo cru (HMAC-SHA256)', () => {
	const raw = '{"a":1}'
	const expected = createHmac('sha256', 'segredo').update(`E1.${raw}`).digest('hex')
	assert.equal(signPayload('E1', raw, 'segredo'), expected)
})

test('signPayload muda se o event_id for adulterado', () => {
	const raw = '{"a":1}'
	assert.notEqual(signPayload('E1', raw, 's'), signPayload('E2', raw, 's'))
})

test('computeBackoffMs cresce exponencial com teto de 5min', () => {
	assert.equal(computeBackoffMs(0), 1000)
	assert.equal(computeBackoffMs(1), 2000)
	assert.equal(computeBackoffMs(2), 4000)
	assert.equal(computeBackoffMs(20), 5 * 60 * 1000) // teto
})

test('classifyStatus mapeia faixas de resposta', () => {
	assert.equal(classifyStatus(200), 'sent')
	assert.equal(classifyStatus(201), 'sent')
	assert.equal(classifyStatus(400), 'dead')
	assert.equal(classifyStatus(422), 'dead')
	assert.equal(classifyStatus(401), 'auth')
	assert.equal(classifyStatus(403), 'auth')
	assert.equal(classifyStatus(500), 'retry')
	assert.equal(classifyStatus(429), 'retry')
	assert.equal(classifyStatus(408), 'retry')
})

test('sendOnce manda headers corretos e classifica 2xx como sent', async () => {
	let captured: any = null
	const fakeFetch = (async (url: string, init: any) => {
		captured = { url, init }
		return { status: 201 } as Response
	}) as unknown as typeof fetch
	const res = await sendOnce({ event_id: 'E1', body: { type: 'x', n: 1 } }, { url: 'http://h/whatsapp', secret: 's', fetchFn: fakeFetch })
	assert.equal(res.outcome, 'sent')
	assert.equal(res.status, 201)
	assert.equal(captured.init.headers['X-Event-Id'], 'E1')
	assert.equal(captured.init.headers['X-Signature'], signPayload('E1', JSON.stringify({ type: 'x', n: 1 }), 's'))
})

test('sendOnce classifica 422 como dead e 401 como auth', async () => {
	const dead = await sendOnce({ event_id: 'E', body: {} }, { url: 'u', secret: 's', fetchFn: (async () => ({ status: 422 })) as unknown as typeof fetch })
	assert.equal(dead.outcome, 'dead')
	const auth = await sendOnce({ event_id: 'E', body: {} }, { url: 'u', secret: 's', fetchFn: (async () => ({ status: 401 })) as unknown as typeof fetch })
	assert.equal(auth.outcome, 'auth')
})

test('sendOnce retorna retry em erro de rede', async () => {
	const fakeFetch = (async () => { throw new Error('down') }) as unknown as typeof fetch
	const res = await sendOnce({ event_id: 'E1', body: { type: 'x' } }, { url: 'u', secret: 's', fetchFn: fakeFetch })
	assert.equal(res.outcome, 'retry')
	assert.equal(res.status, null)
})

test('sendOnce aborta por timeout e classifica como retry', async () => {
	// fetch que respeita o AbortSignal e nunca resolve sozinho
	const fakeFetch = ((_url: string, init: any) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(new Error('aborted')))
	})) as unknown as typeof fetch
	const res = await sendOnce({ event_id: 'E1', body: {} }, { url: 'u', secret: 's', fetchFn: fakeFetch, timeoutMs: 10 })
	assert.equal(res.outcome, 'retry')
})
