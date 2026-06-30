import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBanCommand, messageText, resolveBanTarget, createBanHandler } from '../../src/collector/ban-command.js'
import type { BanMessage, BanGroupMetadata, BanSocket, BanUpdateResult } from '../../src/collector/ban-command.js'

test('parseBanCommand: aceita /ban como primeiro token (com reply ou menção)', () => {
	for (const t of ['/ban', ' /ban ', '/BAN', '/ban @Fulano', '/BAN @x']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
})

test('parseBanCommand: rejeita o que não é o comando', () => {
	for (const t of ['/bandido', 'ban', 'oi /ban', '', 'oi', '/banir']) {
		assert.equal(parseBanCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

test('messageText: lê conversation', () => {
	const msg: BanMessage = { message: { conversation: '/ban' } }
	assert.equal(messageText(msg), '/ban')
})

test('messageText: lê extendedTextMessage.text', () => {
	const msg: BanMessage = { message: { extendedTextMessage: { text: '/ban @x' } } }
	assert.equal(messageText(msg), '/ban @x')
})

test('messageText: sem texto → string vazia', () => {
	assert.equal(messageText({}), '')
	assert.equal(messageText({ message: {} }), '')
})

test('resolveBanTarget: reply usa contextInfo.participant', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'victim@s.whatsapp.net', stanzaId: 'S1' } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: menção usa o primeiro mentionedJid', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @x', contextInfo: { mentionedJid: ['victim@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: reply tem prioridade sobre menção', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @y', contextInfo: { participant: 'reply@s.whatsapp.net', stanzaId: 'S1', mentionedJid: ['mention@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'reply@s.whatsapp.net')
})

test('resolveBanTarget: sem reply e sem menção → null', () => {
	assert.equal(resolveBanTarget({ message: { conversation: '/ban' } }), null)
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: {} } } }), null)
	// participant sem stanzaId não conta como reply
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'x@s.whatsapp.net' } } } }), null)
})

// ---- helpers do handler ----
const ADMIN = 'admin@s.whatsapp.net'
const VICTIM = 'victim@s.whatsapp.net'
const OWNER = 'owner@s.whatsapp.net'
const GROUP = 'g@g.us'
const COMMUNITY = 'community@g.us'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// sock fake: captura chamadas de remoção e serve metadata do grupo (e opcionalmente do pai).
function fakeSock(meta: Partial<BanGroupMetadata>, opts: { parent?: BanGroupMetadata; result?: BanUpdateResult[]; throwMeta?: boolean; throwRemove?: boolean } = {}) {
	const calls = { group: [] as Array<{ jid: string; jids: string[] }>, community: [] as Array<{ jid: string; jids: string[] }> }
	const sock: BanSocket = {
		async groupMetadata(jid: string): Promise<BanGroupMetadata> {
			if (opts.throwMeta) throw new Error('meta boom')
			if (opts.parent && jid === opts.parent.id) return opts.parent
			return { id: jid, owner: meta.owner ?? null, linkedParent: meta.linkedParent ?? null, participants: meta.participants ?? [] }
		},
		async groupParticipantsUpdate(jid, jids) {
			if (opts.throwRemove) throw new Error('remove boom')
			calls.group.push({ jid, jids }); return opts.result ?? [{ status: '200', jid: jids[0] }]
		},
		async communityParticipantsUpdate(jid, jids) {
			if (opts.throwRemove) throw new Error('remove boom')
			calls.community.push({ jid, jids }); return opts.result ?? [{ status: '200', jid: jids[0] }]
		},
	}
	return { sock, calls }
}

// monta um messages.upsert com um único comando /ban (reply por padrão).
function banUpsert(opts: { group?: string; actor?: string; text?: string; reply?: string; mention?: string } = {}) {
	const ctx: Record<string, unknown> = {}
	if (opts.reply) { ctx.participant = opts.reply; ctx.stanzaId = 'S1' }
	if (opts.mention) ctx.mentionedJid = [opts.mention]
	const msg: BanMessage = {
		key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ADMIN, id: 'CMD1' },
		message: { extendedTextMessage: { text: opts.text ?? '/ban', contextInfo: Object.keys(ctx).length ? ctx : undefined } },
	}
	return { type: 'notify', messages: [msg] }
}

const ADMIN_VICTIM = [{ id: ADMIN, admin: 'admin' as const }, { id: VICTIM, admin: null }]

test('handler: ignora mensagem que não é /ban', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ text: 'oi pessoal', reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: ignora DM (não-grupo)', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ group: '5511@s.whatsapp.net', reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: ignora upsert que não é notify', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	const u = banUpsert({ reply: VICTIM }); u.type = 'append'
	await h.handle(u)
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: /ban sem reply e sem menção → no_target', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({})) // /ban puro
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'no_target')
})

test('handler: autor não-admin → not_admin, sem remoção', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: null }, { id: VICTIM, admin: null }] })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'not_admin')
})

test('handler: auto-ban → self_ban, sem remoção', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: ADMIN }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'self_ban')
})

test('handler: alvo fora do grupo → target_not_member', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: 'stranger@s.whatsapp.net' }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_not_member')
})

test('handler: alvo é admin → target_is_admin', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: 'admin' }, { id: VICTIM, admin: 'admin' }] })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_admin')
})

test('handler: alvo é owner do grupo → target_is_owner', async () => {
	const { sock, calls } = fakeSock({ owner: VICTIM, participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_owner')
})

test('handler: sucesso em grupo standalone → groupParticipantsUpdate', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM }) // sem linkedParent
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.community.length, 0)
	assert.deepEqual(calls.group, [{ jid: GROUP, jids: [VICTIM] }])
	assert.equal(logs.at(-1)?.result, 'removed')
	assert.equal(logs.at(-1)?.status, '200')
})

test('handler: sucesso em comunidade → communityParticipantsUpdate no pai', async () => {
	const { sock, calls } = fakeSock(
		{ linkedParent: COMMUNITY, participants: ADMIN_VICTIM },
		{ parent: { id: COMMUNITY, owner: OWNER, participants: [] } },
	)
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length, 0)
	assert.deepEqual(calls.community, [{ jid: COMMUNITY, jids: [VICTIM] }])
	assert.equal(logs.at(-1)?.result, 'removed')
	assert.equal(logs.at(-1)?.community, COMMUNITY)
})

test('handler: protege o owner da COMUNIDADE → target_is_owner, sem remoção', async () => {
	const { sock, calls } = fakeSock(
		{ linkedParent: COMMUNITY, participants: [{ id: ADMIN, admin: 'admin' }, { id: VICTIM, admin: null }] },
		{ parent: { id: COMMUNITY, owner: VICTIM, participants: [] } },
	)
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_owner')
})

test('handler: menção também resolve e bane', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ text: '/ban @v', mention: VICTIM }))
	assert.deepEqual(calls.group, [{ jid: GROUP, jids: [VICTIM] }])
})

test('handler: groupMetadata falha → metadata_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_VICTIM }, { throwMeta: true })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM })) // não deve lançar
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('handler: falha na remoção → remove_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_VICTIM }, { throwRemove: true })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(logs.at(-1)?.result, 'remove_error')
})
