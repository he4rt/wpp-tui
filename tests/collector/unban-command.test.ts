import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUnbanCommand, createUnbanHandler } from '../../src/collector/unban-command.js'
import type { UnbanSocket } from '../../src/collector/unban-command.js'
import { createDenylist } from '../../src/collector/moderation-denylist.js'
import { createCommunityDirectory } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata } from '../../src/collector/community-directory.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseUnbanCommand: aceita /unban e !unban, rejeita o resto', () => {
	for (const t of ['/unban', ' /UNBAN ', '!unban', '/unban 5500900000002']) {
		assert.equal(parseUnbanCommand(t), true, `deveria aceitar: "${t}"`)
	}
	for (const t of ['/unbanir', 'unban', 'oi /unban', '', '/ban']) {
		assert.equal(parseUnbanCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const ADMIN_COM = '100000000000001@lid'
const MEMBRO = '100000000000003@lid'
const BANIDO = '100000000000004@lid'
const BANIDO_PHONE = '5500900000001'

// o banido NÃO está em nenhum grupo — é justamente o que o ban fez com ele.
const snapshot: Record<string, DirGroupMetadata> = {
	[COMMUNITY]: { id: COMMUNITY, isCommunity: true, participants: [{ id: ADMIN_COM, admin: 'superadmin' }] },
	[GENERAL]: {
		id: GENERAL,
		linkedParent: COMMUNITY,
		participants: [
			{ id: ADMIN_COM, admin: null },
			{ id: MEMBRO, admin: null },
		],
	},
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unban-')), 'denylist.json')

function harness(opts: { seed?: boolean } = {}) {
	const logs: Record<string, unknown>[] = []
	const sock: UnbanSocket = {
		async groupFetchAllParticipating() {
			return snapshot
		},
		async groupMetadata(jid) {
			return snapshot[jid]
		},
	}

	const denylist = createDenylist({ path: tmpFile() })
	if (opts.seed !== false) {
		denylist.add({
			lid: BANIDO,
			phone: BANIDO_PHONE,
			reason: 'spam de cripto',
			by: ADMIN_COM,
			at: '2026-08-18T13:17:59.895Z',
			community: COMMUNITY,
		})
	}

	const handler = createUnbanHandler({
		sock,
		logger: { info: (obj) => logs.push(obj) },
		denylist,
		directory: createCommunityDirectory({ sock, now: () => 1000 }),
	})

	return { handler, logs, denylist, last: () => logs[logs.length - 1] }
}

const upsert = (text: string, opts: { from?: string; reply?: string } = {}) => ({
	type: 'notify',
	messages: [
		{
			key: { remoteJid: GENERAL, participant: opts.from ?? ADMIN_COM, id: 'M1' },
			message: opts.reply
				? { extendedTextMessage: { text, contextInfo: { participant: opts.reply, stanzaId: 'S1' } } }
				: { conversation: text },
		} as CmdMessage,
	],
})

test('/unban por telefone tira da denylist — o caso normal, já que o banido saiu dos grupos', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/unban ${BANIDO_PHONE}`))

	assert.equal(h.last().result, 'unbanned')
	assert.equal(h.last().bannedReason, 'spam de cripto')
	assert.equal(h.last().bannedBy, ADMIN_COM)
	assert.equal(h.last().bannedAt, '2026-08-18T13:17:59.895Z')
	assert.deepEqual(h.denylist.list(), [])
})

test('/unban por reply casa pelo @lid quando a mensagem antiga ainda está no grupo', async () => {
	const h = harness()
	await h.handler.handle(upsert('/unban', { reply: BANIDO }))

	assert.equal(h.last().result, 'unbanned')
	assert.deepEqual(h.denylist.list(), [])
})

test('/unban de quem não está na denylist não faz nada', async () => {
	const h = harness()
	await h.handler.handle(upsert('/unban 5500900000009'))

	assert.equal(h.last().result, 'not_in_denylist')
	assert.equal(h.denylist.list().length, 1, 'a lista fica intacta')
})

test('/unban desarma o pré-ban (entrada que só tinha telefone)', async () => {
	const h = harness({ seed: false })
	h.denylist.add({ lid: null, phone: '5500900000009', reason: 'golpe', by: ADMIN_COM, at: 'x', community: COMMUNITY })

	await h.handler.handle(upsert('/unban 5500900000009'))
	assert.equal(h.last().result, 'unbanned')
	assert.deepEqual(h.denylist.list(), [])
})

test('/unban sem alvo audita no_target', async () => {
	const h = harness()
	await h.handler.handle(upsert('/unban'))
	assert.equal(h.last().result, 'no_target')
	assert.equal(h.denylist.list().length, 1)
})

test('/unban de quem não é admin da comunidade é recusado', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/unban ${BANIDO_PHONE}`, { from: MEMBRO }))

	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.denylist.list().length, 1, 'a lista fica intacta')
})

test('/unban não reage a /ban nem a mensagem comum', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${BANIDO_PHONE}`))
	await h.handler.handle(upsert('oi pessoal'))
	assert.deepEqual(h.logs, [])
	assert.equal(h.denylist.list().length, 1)
})
