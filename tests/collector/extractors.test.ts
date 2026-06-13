import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractEvents } from '../../src/collector/extractors.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('messages.upsert: 1 envelope por mensagem, payload cru, chat_jid e event_id UUIDv5', () => {
	const msg = {
		key: { remoteJid: '120363@g.us', participant: '5511@s.whatsapp.net', id: 'MSG1' },
		messageTimestamp: 1700000000,
		message: { conversation: 'oi' },
	}
	const out = extractEvents('messages.upsert', { type: 'notify', messages: [msg] })
	assert.equal(out.length, 1)
	assert.equal(out[0].body.type, 'messages.upsert')
	assert.equal(out[0].body.chat_jid, '120363@g.us')
	assert.deepEqual(out[0].body.payload, msg)
	assert.match(out[0].event_id, UUID_RE)
})

test('messages.upsert: notify e append da MESMA msg colapsam (event_id idêntico = backfill idempotente)', () => {
	const base = { key: { remoteJid: '120363@g.us', id: 'MSG1' }, message: { conversation: 'oi' } }
	const notify = extractEvents('messages.upsert', { type: 'notify', messages: [{ ...base, messageTimestamp: 1700000000 }] })
	// re-entrega offline: mesmo remoteJid+id, messageTimestamp diferente → event_id deve ser o MESMO
	const append = extractEvents('messages.upsert', { type: 'append', messages: [{ ...base, messageTimestamp: 1700000999 }] })
	assert.equal(notify[0].event_id, append[0].event_id)
})

test('messages.reaction: fan-out por reação; troca de emoji muda o event_id', () => {
	const data = [
		{ key: { remoteJid: '120363@g.us', id: 'MSG1' }, reaction: { text: '😂', key: { participant: 'A@s.whatsapp.net' } } },
		{ key: { remoteJid: '120363@g.us', id: 'MSG1' }, reaction: { text: '🔥', key: { participant: 'B@s.whatsapp.net' } } },
	]
	const out = extractEvents('messages.reaction', data)
	assert.equal(out.length, 2)
	assert.equal(out[0].body.chat_jid, '120363@g.us')
	assert.deepEqual(out[1].body.payload, data[1])

	// mesmo reactor troca 😂 → ☕ na mesma msg: event_id muda (mudança de estado preservada)
	const swapped = extractEvents('messages.reaction', [
		{ key: { remoteJid: '120363@g.us', id: 'MSG1' }, reaction: { text: '☕', key: { participant: 'A@s.whatsapp.net' } } },
	])
	assert.notEqual(out[0].event_id, swapped[0].event_id)
})

test('messages.reaction: senderTimestampMs NÃO entra na chave (re-emit colapsa)', () => {
	const a = extractEvents('messages.reaction', [
		{ key: { remoteJid: '120363@g.us', id: 'MSG1' }, reaction: { text: '😂', senderTimestampMs: 111, key: { participant: 'A@s.whatsapp.net' } } },
	])
	const b = extractEvents('messages.reaction', [
		{ key: { remoteJid: '120363@g.us', id: 'MSG1' }, reaction: { text: '😂', senderTimestampMs: 999, key: { participant: 'A@s.whatsapp.net' } } },
	])
	assert.equal(a[0].event_id, b[0].event_id)
})

test('group-participants.update: 1 envelope cru; delta idêntico colapsa, delta diferente = novo id', () => {
	const data = { id: '120363@g.us', action: 'add', participants: ['A@s.whatsapp.net', 'B@s.whatsapp.net'] }
	const out = extractEvents('group-participants.update', data)
	assert.equal(out.length, 1)
	assert.equal(out[0].body.chat_jid, '120363@g.us')
	assert.deepEqual(out[0].body.payload, data)

	const same = extractEvents('group-participants.update', { ...data })
	assert.equal(out[0].event_id, same[0].event_id)
	const removed = extractEvents('group-participants.update', { id: '120363@g.us', action: 'remove', participants: ['A@s.whatsapp.net'] })
	assert.notEqual(out[0].event_id, removed[0].event_id)
})

test('groups.metadata: snapshot idêntico (ordem de participants distinta) colapsa', () => {
	const meta1 = {
		id: '120363@g.us',
		subject: 'He4rt Devs',
		participants: [{ id: 'A@lid', admin: 'superadmin' }, { id: 'B@lid', admin: null }],
	}
	const meta2 = {
		id: '120363@g.us',
		subject: 'He4rt Devs',
		participants: [{ id: 'B@lid', admin: null }, { id: 'A@lid', admin: 'superadmin' }], // ordem trocada
	}
	const out1 = extractEvents('groups.metadata', meta1)
	const out2 = extractEvents('groups.metadata', meta2)
	assert.equal(out1[0].body.type, 'groups.metadata')
	assert.equal(out1[0].event_id, out2[0].event_id) // reconexão não cria snapshot duplicado
})

test('evento desconhecido cai no genérico (array de {id}), payload cru', () => {
	const data = [{ id: '120363@g.us', unreadCount: 3 }]
	const out = extractEvents('chats.update', data)
	assert.equal(out.length, 1)
	assert.equal(out[0].body.type, 'chats.update')
	assert.equal(out[0].body.chat_jid, '120363@g.us')
	assert.deepEqual(out[0].body.payload, data[0])
})

test('genérico resolve o JID por groupId (fix do group.member-tag.update)', () => {
	const data = { groupId: '120363@g.us', tag: 'something' }
	const out = extractEvents('group.member-tag.update', data)
	assert.equal(out.length, 1)
	assert.equal(out[0].body.chat_jid, '120363@g.us') // antes era null → descartado pelo filtro de grupo
})
