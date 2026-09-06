import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPingHandler } from '../../src/collector/ping-command.js'

test('ping: responde no grupo para qualquer membro, com ambos os prefixos', async () => {
	const sent: unknown[] = []
	const handler = createPingHandler({
		sock: { sendMessage: async (jid, content) => { sent.push({ jid, content }) } },
		logger: { info: () => {} },
	})
	await handler.handle({
		type: 'notify',
		messages: [
			{ key: { remoteJid: 'a@g.us' }, message: { conversation: '!ping' } },
			{ key: { remoteJid: 'b@g.us' }, message: { extendedTextMessage: { text: '/PING' } } },
		],
	})
	assert.deepEqual(sent, [
		{ jid: 'a@g.us', content: { text: '🏓 Pong! Estou online.' } },
		{ jid: 'b@g.us', content: { text: '🏓 Pong! Estou online.' } },
	])
})

test('ping: falha de envio é registrada e não impede o próximo ping', async () => {
	let attempts = 0
	const logs: Record<string, unknown>[] = []
	const handler = createPingHandler({
		sock: { sendMessage: async () => { if (++attempts === 1) throw new Error('offline') } },
		logger: { info: (entry) => { logs.push(entry) } },
	})
	await handler.handle({
		type: 'notify',
		messages: ['a@g.us', 'b@g.us'].map((remoteJid) => ({
			key: { remoteJid }, message: { conversation: '!ping' },
		})),
	})
	assert.equal(attempts, 2)
	assert.deepEqual(logs.map((entry) => entry.result), ['handler_error', 'ok'])
})
