import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKickCommand, createKickHandler } from '../../src/collector/kick-command.js'
import { createBanHandler } from '../../src/collector/ban-command.js'
import { createCommunityDirectory } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata } from '../../src/collector/community-directory.js'
import type { RemovalSocket, RemovalUpdateResult } from '../../src/collector/removal-command.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseKickCommand: aceita /kick e !kick, rejeita o resto', () => {
	for (const t of ['/kick', ' /KICK ', '!kick', '/kick @Fulano', '/kick 5500900000002']) {
		assert.equal(parseKickCommand(t), true, `deveria aceitar: "${t}"`)
	}
	for (const t of ['/kickban', 'kick', 'oi /kick', '', '/ban']) {
		assert.equal(parseKickCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const MARKETING = '120363000000000003@g.us'

const ADMIN_COM = '100000000000001@lid'
const MEMBRO = '100000000000003@lid' // está no Grupo Geral E no Grupo Secundário
const SO_MARKETING = '100000000000004@lid' // está só no Grupo Secundário
const PHONE_SO_MARKETING = '5500900000001'

function snapshot(): Record<string, DirGroupMetadata> {
	return {
		[COMMUNITY]: {
			id: COMMUNITY,
			subject: 'Comunidade Exemplo',
			isCommunity: true,
			participants: [{ id: ADMIN_COM, admin: 'superadmin' }],
		},
		[GENERAL]: {
			id: GENERAL,
			linkedParent: COMMUNITY,
			participants: [
				{ id: ADMIN_COM, admin: null },
				{ id: MEMBRO, admin: null },
			],
		},
		[MARKETING]: {
			id: MARKETING,
			linkedParent: COMMUNITY,
			participants: [
				{ id: MEMBRO, admin: null },
				{ id: SO_MARKETING, phoneNumber: `${PHONE_SO_MARKETING}@s.whatsapp.net`, admin: null },
			],
		},
	}
}

interface Call {
	kind: 'community' | 'group'
	jid: string
	jids: string[]
}

function harness() {
	const calls: Call[] = []
	const logs: Record<string, unknown>[] = []
	const snap = snapshot()
	const result = (jids: string[]): RemovalUpdateResult[] => [{ status: '200', jid: jids[0] }]

	const sock: RemovalSocket = {
		async groupFetchAllParticipating() {
			return snap
		},
		async groupMetadata(jid) {
			return snap[jid]
		},
		async groupParticipantsUpdate(jid, jids) {
			calls.push({ kind: 'group', jid, jids })
			return result(jids)
		},
		async communityParticipantsUpdate(jid, jids) {
			calls.push({ kind: 'community', jid, jids })
			return result(jids)
		},
	}

	const directory = createCommunityDirectory({ sock, now: () => 1000 })
	const logger = { info: (obj: Record<string, unknown>) => logs.push(obj) }
	return {
		kick: createKickHandler({ sock, logger, directory }),
		ban: createBanHandler({ sock, logger, directory }),
		calls,
		logs,
		last: () => logs[logs.length - 1],
	}
}

const upsert = (text: string, opts: { from?: string; group?: string; reply?: string } = {}) => ({
	type: 'notify',
	messages: [
		{
			key: { remoteJid: opts.group ?? GENERAL, participant: opts.from ?? ADMIN_COM, id: 'M1' },
			message: opts.reply
				? { extendedTextMessage: { text, contextInfo: { participant: opts.reply, stanzaId: 'S1' } } }
				: { conversation: text },
		} as CmdMessage,
	],
})

test('/kick remove só do grupo atual, sem tocar na comunidade', async () => {
	const h = harness()
	await h.kick.handle(upsert('/kick', { reply: MEMBRO }))

	assert.deepEqual(h.calls, [{ kind: 'group', jid: GENERAL, jids: [MEMBRO] }])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().reach, 'group')
	assert.deepEqual(h.last().removedFrom, [GENERAL])
})

test('/ban no mesmo alvo cascateia pela comunidade — a diferença entre os dois comandos', async () => {
	const h = harness()
	await h.ban.handle(upsert('/ban', { reply: MEMBRO }))

	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [MEMBRO] }])
	assert.equal(h.last().reach, 'community')
	assert.deepEqual(h.last().removedFrom, [GENERAL, MARKETING])
})

test('/kick de quem está só em OUTRO subgrupo é recusado', async () => {
	const h = harness()
	await h.kick.handle(upsert(`/kick ${PHONE_SO_MARKETING}`))

	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'target_not_in_group')
	assert.equal(h.last().target, SO_MARKETING)
})

test('/kick usa a mesma autorização do /ban: admin da comunidade', async () => {
	const h = harness()
	await h.kick.handle(upsert('/kick', { from: MEMBRO, reply: ADMIN_COM }))

	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'not_authorized')
})

test('/kick respeita os guardrails de alvo (admin da comunidade)', async () => {
	const h = harness()
	await h.kick.handle(upsert('/kick', { reply: ADMIN_COM }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'self_ban')
})

test('/kick por telefone de quem está no grupo atual funciona', async () => {
	const h = harness()
	await h.kick.handle(upsert(`/kick ${PHONE_SO_MARKETING}`, { group: MARKETING }))

	assert.deepEqual(h.calls, [{ kind: 'group', jid: MARKETING, jids: [SO_MARKETING] }])
	assert.equal(h.last().result, 'removed')
})

test('/ban não responde a /kick e vice-versa', async () => {
	const h = harness()
	await h.ban.handle(upsert('/kick', { reply: MEMBRO }))
	await h.kick.handle(upsert('/ban', { reply: MEMBRO }))
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})
