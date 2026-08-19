import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDenylistEnforcer } from '../../src/collector/denylist-enforcer.js'
import type { EnforcerSocket, ParticipantsUpdate } from '../../src/collector/denylist-enforcer.js'
import { createDenylist } from '../../src/collector/moderation-denylist.js'
import { createCommunityDirectory } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata } from '../../src/collector/community-directory.js'

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const SOLTO = '120363000000000009@g.us'
const BANIDO = '100000000000004@lid'
const BANIDO_PN = '5500900000001@s.whatsapp.net'
const INOCENTE = '100000000000003@lid'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enforcer-')), 'denylist.json')

const snapshot: Record<string, DirGroupMetadata> = {
	[COMMUNITY]: { id: COMMUNITY, isCommunity: true, participants: [{ id: 'chefe@lid', admin: 'superadmin' }] },
	[GENERAL]: { id: GENERAL, linkedParent: COMMUNITY, participants: [{ id: 'chefe@lid', admin: null }] },
	[SOLTO]: { id: SOLTO, participants: [{ id: 'chefe@lid', admin: 'admin' }] },
}

interface Call {
	kind: 'community' | 'group'
	jid: string
	jids: string[]
}

function harness(opts: { status?: string; entry?: { lid?: string | null; phone?: string | null } } = {}) {
	const calls: Call[] = []
	const logs: Record<string, unknown>[] = []
	let clock = 1000

	const sock: EnforcerSocket = {
		async groupFetchAllParticipating() {
			return snapshot
		},
		async groupMetadata(jid) {
			return snapshot[jid]
		},
		async groupParticipantsUpdate(jid, jids) {
			calls.push({ kind: 'group', jid, jids })
			return [{ status: opts.status ?? '200', jid: jids[0] }]
		},
		async communityParticipantsUpdate(jid, jids) {
			calls.push({ kind: 'community', jid, jids })
			return [{ status: opts.status ?? '200', jid: jids[0] }]
		},
	}

	const denylist = createDenylist({ path: tmpFile() })
	denylist.add({
		lid: opts.entry?.lid !== undefined ? opts.entry.lid : BANIDO,
		phone: opts.entry?.phone !== undefined ? opts.entry.phone : '5500900000001',
		reason: 'spam de cripto',
		by: 'chefe@lid',
		at: '2026-08-18T13:17:59.895Z',
		community: COMMUNITY,
	})

	const enforcer = createDenylistEnforcer({
		sock,
		logger: { info: (obj) => logs.push(obj) },
		denylist,
		directory: createCommunityDirectory({ sock, now: () => 1000 }),
		now: () => clock,
	})

	return { enforcer, calls, logs, denylist, last: () => logs[logs.length - 1], advance: (ms: number) => (clock += ms) }
}

const addEvent = (over: Partial<ParticipantsUpdate> = {}): ParticipantsUpdate => ({
	id: GENERAL,
	author: 'quemadicionou@lid',
	action: 'add',
	participants: [{ id: BANIDO, phoneNumber: BANIDO_PN }],
	...over,
})

test('reentrada de banido é removida de novo, pela comunidade', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent())

	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [BANIDO] }])
	assert.equal(h.last().result, 'enforced')
	assert.equal(h.last().reach, 'community')
	assert.equal(h.last().reason, 'spam de cripto')
	assert.equal(h.last().addedBy, 'quemadicionou@lid')
})

test('pré-ban (só telefone) casa na entrada e completa o @lid na denylist', async () => {
	const h = harness({ entry: { lid: null } })
	await h.enforcer.handle(addEvent())

	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [BANIDO] }])
	assert.equal(h.denylist.match({ lid: BANIDO })?.lid, BANIDO)
})

test('adicionado à mão por admin é removido igual (não só entrada por link)', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent({ author: 'admin@lid' }))
	assert.equal(h.calls.length, 1)
	assert.equal(h.last().addedBy, 'admin@lid')
})

test('grupo sem comunidade remove só do grupo', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent({ id: SOLTO }))
	assert.deepEqual(h.calls, [{ kind: 'group', jid: SOLTO, jids: [BANIDO] }])
	assert.equal(h.last().reach, 'group')
})

test('quem não está na denylist é ignorado por completo', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent({ participants: [{ id: INOCENTE, phoneNumber: '5500900000009@s.whatsapp.net' }] }))
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})

test('ação que não é add não dispara nada', async () => {
	const h = harness()
	for (const action of ['remove', 'promote', 'demote']) {
		await h.enforcer.handle(addEvent({ action }))
	}
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})

test('entrada na comunidade dispara um add por subgrupo — só a primeira remove', async () => {
	const h = harness()
	// é o que os logs reais mostram: mesmo alvo, mesmo instante, dois grupos
	await h.enforcer.handle(addEvent({ id: GENERAL }))
	await h.enforcer.handle(addEvent({ id: COMMUNITY }))

	assert.equal(h.calls.length, 1)
	assert.equal(h.last().result, 'duplicate_ignored')
})

test('passada a janela de dedupe, uma nova reentrada é tratada', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent())
	h.advance(11_000)
	await h.enforcer.handle(addEvent())
	assert.equal(h.calls.length, 2)
})

test('status != 200 vira enforce_rejected, não enforced', async () => {
	const h = harness({ status: '403' })
	await h.enforcer.handle(addEvent())
	assert.equal(h.last().result, 'enforce_rejected')
	assert.equal(h.last().status, '403')
})

test('handle nunca lança, mesmo com evento malformado', async () => {
	const h = harness()
	await h.enforcer.handle(undefined as unknown as ParticipantsUpdate)
	await h.enforcer.handle({ id: GENERAL, action: 'add' } as ParticipantsUpdate)
	await h.enforcer.handle(addEvent({ id: '5511999@s.whatsapp.net' })) // DM
	assert.deepEqual(h.calls, [])
})

test('enforcer: o log da reentrada traz o nome do grupo', async () => {
	const h = harness()
	await h.enforcer.handle(addEvent())
	assert.equal(h.last().group, GENERAL)
	assert.equal(h.last().groupName, GENERAL, 'sem resolvedor injetado, cai no próprio JID')
})
