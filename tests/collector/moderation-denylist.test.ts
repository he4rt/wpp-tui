import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDenylist } from '../../src/collector/moderation-denylist.js'
import type { DenylistEntry } from '../../src/collector/moderation-denylist.js'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-')), 'denylist.json')

const entry = (over: Partial<DenylistEntry> = {}): DenylistEntry => ({
	lid: '100000000000004@lid',
	phone: '5500900000001',
	reason: 'spam',
	by: '100000000000001@lid',
	at: '2026-08-18T13:17:59.895Z',
	community: '120363000000000001@g.us',
	...over,
})

test('denylist: casa por @lid e por telefone', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry())

	assert.equal(d.match({ lid: '100000000000004@lid' })?.reason, 'spam')
	assert.equal(d.match({ phone: '5500900000001' })?.reason, 'spam')
	// o evento de entrada traz o telefone como JID cru — normaliza igual
	assert.equal(d.match({ phone: '5500900000001@s.whatsapp.net' })?.reason, 'spam')
	assert.equal(d.match({ lid: 'outro@lid', phone: '5500900000009' }), null)
})

test('denylist: pré-ban só com telefone casa quando a pessoa entra', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry({ lid: null, reason: 'pré-ban' }))

	// entrou: o evento traz lid + phoneNumber; o telefone é o que casa
	assert.equal(d.match({ lid: '999@lid', phone: '5500900000001' })?.reason, 'pré-ban')
})

test('denylist: rebanir faz upsert e nunca apaga identidade já conhecida', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry({ lid: null, reason: 'pré-ban' })) // só telefone
	d.add(entry({ phone: null, reason: 'flood' })) // só lid, mesmo alvo? não casa ainda

	// a segunda entrada não casou (identidades disjuntas): são duas
	assert.equal(d.list().length, 2)

	// agora um ban com os DOIS campos casa com a primeira (por telefone) e a completa
	d.add(entry({ reason: 'spam de cripto' }))
	const byPhone = d.match({ phone: '5500900000001' })!
	assert.equal(byPhone.reason, 'spam de cripto')
	assert.equal(byPhone.lid, '100000000000004@lid')
})

test('denylist: add preserva o lid antigo quando o novo ban não o traz', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry())
	d.add(entry({ lid: null, reason: 'reincidente' }))

	const found = d.match({ phone: '5500900000001' })!
	assert.equal(found.lid, '100000000000004@lid')
	assert.equal(found.reason, 'reincidente')
	assert.equal(d.list().length, 1)
})

test('denylist: remove devolve quem saiu e some da lista', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry())

	assert.equal(d.remove({ phone: '5500900000001' })?.lid, '100000000000004@lid')
	assert.equal(d.match({ lid: '100000000000004@lid' }), null)
	assert.deepEqual(d.list(), [])
	assert.equal(d.remove({ phone: '5500900000001' }), null)
})

test('denylist: persiste entre instâncias (sobrevive a restart)', () => {
	const file = tmpFile()
	createDenylist({ path: file }).add(entry())

	const reaberta = createDenylist({ path: file })
	assert.equal(reaberta.match({ lid: '100000000000004@lid' })?.reason, 'spam')
})

test('denylist: arquivo corrompido não derruba a moderação', () => {
	const file = tmpFile()
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, '{ isso não é json')

	const d = createDenylist({ path: file })
	assert.deepEqual(d.list(), [])
	d.add(entry())
	assert.equal(d.match({ phone: '5500900000001' })?.reason, 'spam')
})

test('denylist: list devolve cópias (mutar o retorno não altera a lista)', () => {
	const d = createDenylist({ path: tmpFile() })
	d.add(entry())
	d.list()[0].reason = 'adulterado'
	assert.equal(d.match({ phone: '5500900000001' })?.reason, 'spam')
})

test('denylist: migra automaticamente do caminho antigo em logs/', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-mig-'))
	const legacy = path.join(dir, 'logs', 'denylist.json')
	const novo = path.join(dir, 'data', 'denylist.json')

	// simula a lista que já existia no servidor antes da mudança de lugar
	fs.mkdirSync(path.dirname(legacy), { recursive: true })
	fs.writeFileSync(legacy, JSON.stringify({ entries: [entry()] }))

	const d = createDenylist({ path: novo, legacyPath: legacy })
	assert.equal(d.match({ lid: '100000000000004@lid' })?.reason, 'spam', 'ninguém pode sumir na migração')
	assert.ok(fs.existsSync(novo), 'deve gravar no lugar novo')
	assert.ok(fs.existsSync(legacy), 'o antigo fica como rede de segurança')
})

test('denylist: não migra por cima de uma lista já existente no lugar novo', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-mig2-'))
	const legacy = path.join(dir, 'logs', 'denylist.json')
	const novo = path.join(dir, 'data', 'denylist.json')

	fs.mkdirSync(path.dirname(legacy), { recursive: true })
	fs.writeFileSync(legacy, JSON.stringify({ entries: [entry({ reason: 'antigo' })] }))
	fs.mkdirSync(path.dirname(novo), { recursive: true })
	fs.writeFileSync(novo, JSON.stringify({ entries: [entry({ reason: 'atual' })] }))

	const d = createDenylist({ path: novo, legacyPath: legacy })
	assert.equal(d.match({ lid: '100000000000004@lid' })?.reason, 'atual')
	assert.equal(d.list().length, 1)
})
