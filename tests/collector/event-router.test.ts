import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventRouter, DENYLIST } from '../../src/collector/event-router.js'
import type { OutboxEvent } from '../../src/collector/types.js'

function fakeOutbox() {
	const items: OutboxEvent[] = []
	return { items, enqueue: (e: OutboxEvent) => { items.push(e) } }
}

test('denylist bloqueia eventos de sessão/estado', () => {
	const ob = fakeOutbox()
	const router = createEventRouter(ob)
	router.handleEvent('creds.update', { foo: 'bar' })
	router.handleEvent('messaging-history.set', {})
	assert.equal(ob.items.length, 0)
})

test('denylist corta os firehoses (presence e recibos)', () => {
	const ob = fakeOutbox()
	const router = createEventRouter(ob)
	router.handleEvent('presence.update', { id: '120363@g.us', presences: { 'A@s.whatsapp.net': { lastKnownPresence: 'composing' } } })
	router.handleEvent('message-receipt.update', [{ key: { remoteJid: '120363@g.us' } }])
	assert.equal(ob.items.length, 0)
})

test('mensagem de grupo é enfileirada com chat_jid e event_id', () => {
	const ob = fakeOutbox()
	const router = createEventRouter(ob)
	router.handleEvent('messages.upsert', {
		messages: [{ key: { remoteJid: '120363@g.us', participant: 'A@s.whatsapp.net', id: 'M1' }, messageTimestamp: 1700000000, message: { conversation: 'oi' } }],
	})
	assert.equal(ob.items.length, 1)
	assert.equal(ob.items[0].body.chat_jid, '120363@g.us')
	assert.ok(ob.items[0].event_id.length > 0)
})

test('DM é descartada pelo filtro de escopo', () => {
	const ob = fakeOutbox()
	const router = createEventRouter(ob)
	router.handleEvent('messages.upsert', {
		messages: [{ key: { remoteJid: '5511@s.whatsapp.net', id: 'M2' }, messageTimestamp: 1700000000, message: { conversation: 'privado' } }],
	})
	assert.equal(ob.items.length, 0)
})

test('group.member-tag.update (JID em groupId) NÃO é mais descartado', () => {
	const ob = fakeOutbox()
	const router = createEventRouter(ob)
	router.handleEvent('group.member-tag.update', { groupId: '120363@g.us', tag: 'x' })
	assert.equal(ob.items.length, 1)
	assert.equal(ob.items[0].body.chat_jid, '120363@g.us')
})

test('DENYLIST contém os tipos esperados (sessão/bulk + 2 firehoses)', () => {
	for (const t of ['creds.update', 'messaging-history.set', 'chats.set', 'contacts.set', 'blocklist.set', 'message-receipt.update', 'presence.update']) {
		assert.ok(DENYLIST.has(t), `faltou ${t}`)
	}
})
