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

const MODERACAO = '120363000000000005@g.us'

function harness(opts: { status?: string; snap?: Record<string, DirGroupMetadata>; throwOnRemove?: boolean; visibility?: boolean } = {}) {
	const calls: Call[] = []
	const logs: Record<string, unknown>[] = []
	const apagadas: Array<{ jid: string; id?: string | null }> = []
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

	const visibility = opts.visibility
		? {
			config: { moderationGroupJid: MODERACAO, logGroupJid: null },
			deleter: {
				async sendMessage(jid: string, content: { delete: { id?: string | null } }) {
					apagadas.push({ jid, id: content.delete?.id })
					return {}
				},
			},
			reporter: { async publish() {} },
		}
		: undefined

	const handler = createBanHandler({
		sock,
		logger: { info: (obj) => logs.push(obj) },
		directory: createCommunityDirectory({ sock, now: () => 1000 }),
		visibility,
	})

	return { handler, calls, logs, apagadas, last: () => logs[logs.length - 1] }
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
	assert.equal(h.last().text, '/ban', 'sem o texto digitado, um no_target não se explica')
})

test('/ban recusado registra o motivo digitado (a recusa também precisa dizer o porquê)', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban 91234-5678 flood no grupo'))
	assert.equal(h.last().result, 'phone_incomplete')
	assert.equal(h.last().reason, 'flood no grupo')
	assert.equal(h.last().text, '/ban 91234-5678 flood no grupo')
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
	assert.equal(h.last().community, COMMUNITY)
	assert.equal(h.last().groupAdmin, true, 'a recusa precisa dizer que era admin do subgrupo')
})

test('/ban de membro comum é recusado', async () => {
	const h = harness()
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: VITIMA, group: MARKETING }))
	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.last().groupAdmin, false, 'membro comum sondando ≠ admin de subgrupo')
	assert.equal(h.last().member, true)
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

test('/ban de telefone completo que não está em nenhum grupo audita target_not_found', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban 5500900000009 golpe'))
	assert.deepEqual(h.calls, [], 'não há de onde remover')
	assert.equal(h.last().result, 'target_not_found')
	assert.equal(h.last().phone, '5500900000009')
	assert.equal(h.last().via, 'phone_not_member')
	assert.equal(h.last().reason, 'golpe', 'o motivo digitado tem de constar mesmo na recusa')
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

// ---- número parcial ----

test('/ban sem o DDI acha a pessoa pelo final do número', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban 00900000001 spam'))

	assert.deepEqual(h.calls, [{ kind: 'community', jid: COMMUNITY, jids: [VITIMA] }])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().via, 'phone_suffix')
})

test('/ban com número incompleto que não casa com ninguém RECUSA', async () => {
	const h = harness()
	await h.handler.handle(upsert('/ban 91234-5678'))

	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'phone_incomplete')
})

test('/ban com final ambíguo recusa e diz quantos casaram', async () => {
	const snap = snapshot()
	snap[MARKETING].participants = [
		{ id: VITIMA, phoneNumber: `${VITIMA_PHONE}@s.whatsapp.net`, admin: null },
		{ id: '100000000000009@lid', phoneNumber: '5511900000001@s.whatsapp.net', admin: null },
	]
	const h = harness({ snap })
	await h.handler.handle(upsert('/ban 900000001'))

	assert.deepEqual(h.calls, [])
	assert.equal(h.last().result, 'phone_ambiguous')
	assert.equal(h.last().candidates, 2)
})

// ---- apagar o comando é privilégio de quem tem autorização ----

test('/ban de admin da comunidade é apagado do grupo', async () => {
	const h = harness({ visibility: true })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE} spam`))

	assert.deepEqual(h.apagadas, [{ jid: GENERAL, id: 'M1' }])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().deleted, true)
})

test('/ban de membro comum NÃO é apagado — o bot não mexe na mensagem de quem não manda', async () => {
	const h = harness({ visibility: true })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: VITIMA, group: MARKETING }))

	assert.deepEqual(h.apagadas, [], 'a mensagem dele fica onde está')
	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.last().deleted, false)
	assert.equal(h.last().deleteSkip, 'not_authorized')
	assert.equal(h.last().text, `/ban ${VITIMA_PHONE}`, 'mas a tentativa fica registrada por inteiro')
})

test('/ban de admin de SUBGRUPO é apagado, embora recusado — moderação negada também não é pública', async () => {
	const h = harness({ visibility: true })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: ADMIN_SUB }))

	assert.deepEqual(h.apagadas, [{ jid: GENERAL, id: 'M1' }], 'tem galão de admin: a mensagem sai da vista')
	assert.deepEqual(h.calls, [], 'mas o comando não age')
	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.last().groupAdmin, true)
	assert.equal(h.last().deleted, true, 'apagar segue o status de quem digitou, não o veredito')
})

test('/ban de quem nem está no grupo não é apagado (não há status a proteger)', async () => {
	const h = harness({ visibility: true })
	// ADMIN_SUB é admin do Grupo Geral, mas não participa do Grupo Secundário
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { from: ADMIN_SUB, group: MARKETING }))

	assert.deepEqual(h.apagadas, [])
	assert.equal(h.last().result, 'not_authorized')
	assert.equal(h.last().groupAdmin, false)
	assert.equal(h.last().member, false)
})

test('/ban autorizado com alvo inválido: apagado mesmo assim (quem mandou podia mandar)', async () => {
	const h = harness({ visibility: true })
	await h.handler.handle(upsert('/ban'))

	assert.deepEqual(h.apagadas, [{ jid: GENERAL, id: 'M1' }])
	assert.equal(h.last().result, 'no_target')
})

test('/ban no grupo de moderação não é apagado (espaço fechado, o histórico ali é a trilha)', async () => {
	const snap = snapshot()
	snap[MODERACAO] = {
		id: MODERACAO,
		subject: 'Moderação',
		linkedParent: COMMUNITY,
		participants: [{ id: ADMIN_COM, admin: 'admin' }, { id: VITIMA, phoneNumber: `${VITIMA_PHONE}@s.whatsapp.net`, admin: null }],
	}
	const h = harness({ visibility: true, snap })
	await h.handler.handle(upsert(`/ban ${VITIMA_PHONE}`, { group: MODERACAO }))

	assert.deepEqual(h.apagadas, [])
	assert.equal(h.last().result, 'removed')
	assert.equal(h.last().deleteSkip, 'private_admin_group')
})
