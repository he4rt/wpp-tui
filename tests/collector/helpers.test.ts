import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGroupJid, eventId, canonicalHash } from '../../src/collector/helpers.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('isGroupJid só aceita @g.us', () => {
	assert.equal(isGroupJid('123@g.us'), true)
	assert.equal(isGroupJid('123@s.whatsapp.net'), false)
	assert.equal(isGroupJid(null), false)
	assert.equal(isGroupJid(undefined), false)
})

test('eventId gera um UUIDv5 válido (versão 5, variante RFC 4122)', () => {
	const id = eventId('messages.upsert', '120363@g.us', 'MSG1')
	assert.match(id, UUID_RE)
	assert.equal(id[14], '5') // nibble de versão
	assert.ok(['8', '9', 'a', 'b'].includes(id[19])) // nibble de variante
})

test('eventId é determinístico: mesmas partes → mesmo id', () => {
	const a = eventId('messages.upsert', '120363@g.us', 'MSG1')
	const b = eventId('messages.upsert', '120363@g.us', 'MSG1')
	assert.equal(a, b)
})

test('eventId difere quando qualquer parte muda', () => {
	const base = eventId('messages.reaction', 'MSG1', 'A@s.whatsapp.net', '😂')
	assert.notEqual(base, eventId('messages.reaction', 'MSG1', 'A@s.whatsapp.net', '☕')) // trocou emoji
	assert.notEqual(base, eventId('messages.reaction', 'MSG2', 'A@s.whatsapp.net', '😂')) // outra msg
	assert.notEqual(base, eventId('messages.reaction', 'MSG1', 'B@s.whatsapp.net', '😂')) // outro reactor
})

test('eventId trata null/undefined como string vazia estável', () => {
	assert.equal(eventId('t', null, 'x'), eventId('t', undefined, 'x'))
})

test('canonicalHash ignora ordem de chaves e ordem de participants', () => {
	const a = { id: 'g@g.us', subject: 'He4rt', participants: [{ id: 'B@lid', admin: null }, { id: 'A@lid', admin: 'superadmin' }] }
	const b = { participants: [{ admin: 'superadmin', id: 'A@lid' }, { admin: null, id: 'B@lid' }], subject: 'He4rt', id: 'g@g.us' }
	assert.equal(canonicalHash(a), canonicalHash(b))
})

test('canonicalHash muda quando o roster muda de verdade', () => {
	const before = { id: 'g@g.us', participants: [{ id: 'A@lid', admin: null }] }
	const after = { id: 'g@g.us', participants: [{ id: 'A@lid', admin: 'admin' }] } // virou admin
	assert.notEqual(canonicalHash(before), canonicalHash(after))
})
