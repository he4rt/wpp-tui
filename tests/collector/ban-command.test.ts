import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBanCommand, messageText, createBanHandler } from '../../src/collector/ban-command.js'
import type { BanMessage, BanSocket, BanUpdateResult } from '../../src/collector/ban-command.js'
import { createCommunityDirectory } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata } from '../../src/collector/community-directory.js'

test('parseBanCommand: aceita /ban como primeiro token (com reply ou menção)', () => {
	for (const t of ['/ban', ' /ban ', '/BAN', '/ban @Fulano', '/BAN @x', '/ban 5500900000002']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
})

test('parseBanCommand: rejeita o que não é o comando', () => {
	for (const t of ['/bandido', 'ban', 'oi /ban', '', 'oi', '/banir']) {
		assert.equal(parseBanCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

test('parseBanCommand: aceita ! como prefixo', () => {
	for (const t of ['!ban', '!BAN', '!ban @Fulano']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
	assert.equal(parseBanCommand('!bandido'), false)
})

test('messageText: lê conversation e extendedTextMessage.text', () => {
	assert.equal(messageText({ message: { conversation: '/ban' } }), '/ban')
	assert.equal(messageText({ message: { extendedTextMessage: { text: '/ban @x' } } }), '/ban @x')
	assert.equal(messageText({}), '')
})

// ---- cenário: topologia de exemplo ----

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const MARKETING = '120363000000000003@g.us'
const SOLTO = '120363000000000009@g.us'

const ADMIN_COM = '100000000000001@lid' // admin da comunidade — quem comanda
const ADMIN_SUB = '100000000000003@lid' // admin só do Grupo Geral — NÃO comanda
const OWNER = '100000000000002@lid'
const VITIMA = '100000000000004@lid' // está só no Grupo Secundário
const VITIMA_PHONE = '5500900000001'

function snapshot(): Record<string, DirGroupMetadata> {
	return {
		[COMMUNITY]: {
			id: COMMUNITY,
			subject: 'Comunidade Exemplo',
			owner: OWNER,
			isCommunity: true,
			participants: [
				{ id: ADMIN_COM, admin: 'superadmin' },
				{ id: OWNER, admin: 'admin' },
			],
		},
		[GENERAL]: {
			id: GENERAL,
			subject: 'Grupo Geral',
			linkedParent: COMMUNITY,
			participants: [
				{ id: ADMIN_SUB, admin: 'admin' },
				{ id: ADMIN_COM, admin: null },
				{ id: OWNER, admin: null },
			],
		},
		[MARKETING]: {
			id: MARKETING,
			subject: 'Grupo Secundário',
			linkedParent: COMMUNITY,
			participants: [{ id: VITIMA, phoneNumber: `${VITIMA_PHONE}@s.whatsapp.net`, admin: null }],
		},
		[SOLTO]: {
			id: SOLTO,
			subject: 'Grupo Solto',
			owner: ADMIN_SUB,
			participants: [
				{ id: ADMIN_SUB, admin: 'admin' },
				{ id: VITIMA, phoneNumber: `${VITIMA_PHONE}@s.whatsapp.net`, admin: null },
			],
		},
	}
}

interface Call {
	kind: 'community' | 'group'
	jid: string
	jids: string[]
}

function harness(opts: { status?: string; snap?: Record<string, DirGroupMetadata>; throwOnRemove?: boolean } = {}) {
	const calls: Call[] = []
	const logs: Record<string, unknown>[] = []
	const snap = opts.snap ?? snapshot()

	const result = (jids: string[]): BanUpdateResult[] => [{ status: opts.status ?? '200', jid: jids[0] }]

	const sock: BanSocket = {
		async groupFetchAllParticipating() {
			return snap
		},
		async groupMetadata(jid) {
			return snap[jid]
		},
		async groupParticipantsUpdate(jid, jids) {
			if (opts.throwOnRemove) throw new Error('boom')
			calls.push({ kind: 'group', jid, jids })
			return result(jids)
		},
		async communityParticipantsUpdate(jid, jids) {
			if (opts.throwOnRemove) throw new Error('boom')
			calls.push({ kind: 'community', jid, jids })
			return result(jids)
		},
	}

	const handler = createBanHandler({
		sock,
		logger: { info: (obj) => logs.push(obj) },
		directory: createCommunityDirectory({ sock, now: () => 1000 }),
	})

	return { handler, calls, logs, last: () => logs[logs.length - 1] }
}

const upsert = (text: string, opts: { from?: string; group?: string; reply?: string; mention?: string } = {}) => ({
	type: 'notify',
	messages: [
		{
			key: { remoteJid: opts.group ?? GENERAL, participant: opts.from ?? ADMIN_COM, id: 'M1' },
			message: opts.reply
				? { extendedTextMessage: { text, contextInfo: { participant: opts.reply, stanzaId: 'S1' } } }
				: opts.mention
					? { extendedTextMessage: { text, contextInfo: { mentionedJid: [opts.mention] } } }
					: { conversation: text },
		} as BanMessage,
	],
})

// ---- o caso que falhou em produção ----

test('/ban por telefone remove alguém que está só em OUTRO subgrupo', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE} spam de cripto`))

	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [VITIMA] }])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().target, VITIMA)
	assert.equal(h.last().via, 'phone')
	assert.equal(h.last().scope, 'community')
	assert.equal(h.last().reason, 'spam de cripto')
	assert.deepEqual(h.last().removedFrom, [MARKETING])
})

test('/ban sem alvo nenhum ainda audita no_target (regressão do log de 18/08)', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban'))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'no_target')
	assert.equal(h.last().target, null)
})

test('/ban por reply e por menção continuam funcionando', async () => {
	for (const opts of [{ reply: VITIMA }, { mention: VITIMA }]) {
		const h = harness()
		await h.handler.handle(upsert('/ban', opts))
		assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [VITIMA] }])
		assert.equal(h.last().result, 'removed')
	}
})

// ---- autorização ----

test('/ban de admin de SUBGRUPO é recusado — a autoridade é da comunidade', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: ADMIN_SUB }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.last().scope, 'community')
})

test('/ban de membro comum é recusado', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: VITIMA, group: MARKETING }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'not_authorized')
})

test('/ban em grupo desconhecido audita group_unknown', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban', { group: '000@g.us', reply: VITIMA }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'group_unknown')
})

// ---- guardrails ----

test('/ban no próprio autor é ignorado', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban', { reply: ADMIN_COM }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'self_ban')
})

test('/ban em admin da comunidade é bloqueado', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban', { from: OWNER, reply: ADMIN_COM }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'target_is_community_admin')
})

test('/ban em admin de subgrupo é PERMITIDO (comunidade manda em subgrupo)', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban', { reply: ADMIN_SUB }))
	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [ADMIN_SUB] }])
	assert.equal(h.last().result, 'removed')
})

test('/ban no owner da comunidade é bloqueado', async () => {
	const snap = snapshot()
	// tira o owner da lista de admins da comunidade p/ o guardrail de owner ser o que barra
	snap[COMMUNITY].participants = [{ id: ADMIN_COM, admin: 'superadmin' }]
	const h = harness({ snap })
	await h.handler.handle(upsert('/ban', { reply: OWNER }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'target_is_owner')
})

test('/ban de quem não está em nenhum grupo do escopo audita target_not_member', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban', { reply: 'fantasma@lid' }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'target_not_member')
})

test('/ban de telefone fora da comunidade audita target_not_found', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban 5500900000009'))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'target_not_found')
	assert.equal(h.last().phone, '5500900000009')
})

// ---- veredito honesto ----

test('status 403 audita remove_rejected, NÃO removed (bot sem admin na comunidade)', async () => {
	const h = harness({ status: '403' })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`))
	assert.equal(h.calls.length, 1)
	assert.equal(h.last().result, 'remove_rejected')
	assert.equal(h.last().status, '403')
})

test('exceção na remoção vira remove_error sem derrubar o handler', async () => {
	const h = harness({ throwOnRemove: true })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`))
	assert.equal(h.last().result, 'remove_error')
})

// ---- grupo standalone ----

test('grupo sem comunidade: admin do próprio grupo comanda e o ban fica só nele', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: ADMIN_SUB, group: SOLTO }))
	assert.deepEqual(h.calls, [{ kind: 'group', jid: SOLTO, jids: [VITIMA] }])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().scope, 'group')
	assert.equal(h.last().community, null)
})

// ---- não-comando / robustez ----

test('mensagem que não é comando não dispara nada', async () => {
	const h = harness()
	await h.handler.handle(upsert('oi pessoal'))
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})

test('upsert que não é notify é ignorado', async () => {
	const h = harness()
	await h.handler.handle({ ...upsert(`/ban ${VITIMA_PHONE}`), type: 'append' })
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})

test('DM não dispara o comando', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { group: '5511999@s.whatsapp.net' }))
	assert.deepEqual(h.calls, [])
	assert.deepEqual(h.logs, [])
})

test('handle nunca lança mesmo com socket quebrado', async () => {
	const sock = {
		async groupFetchAllParticipating(): Promise<Record<string, DirGroupMetadata>> {
			throw new Error('offline')
		},
		async groupMetadata(): Promise<DirGroupMetadata> {
			throw new Error('offline')
		},
		async groupParticipantsUpdate() {
			return []
		},
		async communityParticipantsUpdate() {
			return []
		},
	} satisfies BanSocket
	const logs: Record<string, unknown>[] = []
	const handler = createBanHandler({ sock, logger: { info: (o) => logs.push(o) } })
	await handler.handle(upsert(`/ban ${VITIMA_PHONE}`))
	assert.equal(logs[logs.length - 1].result, 'directory_error')
})
