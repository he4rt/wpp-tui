import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdminAction, createAdminHandler } from '../../src/collector/admin-command.js'
import type { AdminGroupMetadata, AdminSocket } from '../../src/collector/admin-command.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseAdminAction: on/off com prefixo / e !', () => {
	for (const t of ['/admin on', '!admin on', '/ADMIN ON']) assert.equal(parseAdminAction(t), 'on', t)
	for (const t of ['/admin off', '!admin off']) assert.equal(parseAdminAction(t), 'off', t)
})

test('parseAdminAction: sem/argumento inválido/não-comando → null', () => {
	for (const t of ['/admin', '!admin xyz', 'admin on', 'oi /admin on', '/ban on']) {
		assert.equal(parseAdminAction(t), null, t)
	}
})

// ---- helpers do handler ----
const ADMIN = 'admin@s.whatsapp.net'
const MEMBER = 'member@s.whatsapp.net'
const GROUP = 'g@g.us'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// sock fake: captura chamadas de setting e serve metadata do grupo.
function fakeSock(meta: Partial<AdminGroupMetadata>, opts: { throwMeta?: boolean; throwSetting?: boolean } = {}) {
	const calls: Array<{ jid: string; setting: string }> = []
	const sock: AdminSocket = {
		async groupMetadata(jid: string): Promise<AdminGroupMetadata> {
			if (opts.throwMeta) throw new Error('meta boom')
			return { id: jid, announce: meta.announce ?? false, participants: meta.participants ?? [] }
		},
		async groupSettingUpdate(jid, setting) {
			if (opts.throwSetting) throw new Error('setting boom')
			calls.push({ jid, setting })
		},
	}
	return { sock, calls }
}

// monta um messages.upsert com um único comando /admin.
function adminUpsert(opts: { group?: string; actor?: string; text?: string } = {}) {
	const msg: CmdMessage = {
		key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ADMIN, id: 'CMD1' },
		message: { extendedTextMessage: { text: opts.text ?? '/admin on' } },
	}
	return { type: 'notify', messages: [msg] }
}

const ADMIN_MEMBER = [{ id: ADMIN, admin: 'admin' as const }, { id: MEMBER, admin: null }]

test('handler: ignora mensagem que não é /admin', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: 'oi pessoal' }))
	assert.equal(calls.length, 0)
})

test('handler: ignora DM (não-grupo)', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ group: '5511@s.whatsapp.net' }))
	assert.equal(calls.length, 0)
})

test('handler: ignora upsert que não é notify', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	const u = adminUpsert({}); u.type = 'append'
	await h.handle(u)
	assert.equal(calls.length, 0)
})

test('handler: /admin sem argumento válido → no_action', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'no_action')
})

test('handler: autor não-admin → not_admin, sem alteração', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: null }, { id: MEMBER, admin: null }] })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'not_admin')
})

test('handler: on aplica announcement', async () => {
	const { sock, calls } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '!admin on' }))
	assert.deepEqual(calls, [{ jid: GROUP, setting: 'announcement' }])
	assert.equal(logs.at(-1)?.result, 'applied')
	// "applied" sozinho não diz o que o grupo virou
	assert.equal(logs.at(-1)?.action, 'on')
	assert.equal(logs.at(-1)?.announceBefore, false)
	assert.equal(logs.at(-1)?.announceAfter, true)
})

test('handler: off aplica not_announcement', async () => {
	const { sock, calls } = fakeSock({ announce: true, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin off' }))
	assert.deepEqual(calls, [{ jid: GROUP, setting: 'not_announcement' }])
	assert.equal(logs.at(-1)?.result, 'applied')
	assert.equal(logs.at(-1)?.announceBefore, true)
	assert.equal(logs.at(-1)?.announceAfter, false)
})

test('handler: on num grupo já announce → already_on, sem chamada', async () => {
	const { sock, calls } = fakeSock({ announce: true, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'already_on')
	assert.equal(logs.at(-1)?.announceBefore, true)
})

test('handler: off num grupo já liberado → already_off, sem chamada', async () => {
	const { sock, calls } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin off' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'already_off')
})

test('handler: groupMetadata falha → metadata_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_MEMBER }, { throwMeta: true })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('handler: groupSettingUpdate falha → setting_error, sem lançar', async () => {
	const { sock } = fakeSock({ announce: false, participants: ADMIN_MEMBER }, { throwSetting: true })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(logs.at(-1)?.result, 'setting_error')
})

// ---- apagar o comando é privilégio de quem tem autorização ----

const MODERACAO = '120363000000000005@g.us'

// visibility com deleter espião: registra o que seria revogado no grupo.
function espiao() {
	const apagadas: Array<{ jid: string; id?: string | null }> = []
	const visibility = {
		config: { moderationGroupJid: MODERACAO, logGroupJid: null },
		deleter: {
			async sendMessage(jid: string, content: { delete: { id?: string | null } }) {
				apagadas.push({ jid, id: content.delete?.id })
				return {}
			},
		},
		reporter: { async publish() {} },
	}
	return { apagadas, visibility }
}

test('/admin de admin do grupo é apagado', async () => {
	const { sock } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const { apagadas, visibility } = espiao()
	const h = createAdminHandler({ sock, logger, visibility })
	await h.handle(adminUpsert({ text: '/admin on' }))

	assert.deepEqual(apagadas, [{ jid: GROUP, id: 'CMD1' }])
	assert.equal(logs.at(-1)?.result, 'applied')
	assert.equal(logs.at(-1)?.deleted, true)
})

test('/admin de quem não é admin NÃO é apagado, mas fica registrado', async () => {
	const { sock } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const { apagadas, visibility } = espiao()
	const h = createAdminHandler({ sock, logger, visibility })
	await h.handle(adminUpsert({ text: '/admin on', actor: MEMBER }))

	assert.deepEqual(apagadas, [])
	assert.equal(logs.at(-1)?.result, 'not_admin')
	assert.equal(logs.at(-1)?.deleteSkip, 'not_authorized')
	assert.equal(logs.at(-1)?.text, '/admin on')
})

test('/admin sem on|off não é apagado: para antes da autorização, então não se sabe quem mandou', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const { apagadas, visibility } = espiao()
	const h = createAdminHandler({ sock, logger, visibility })
	await h.handle(adminUpsert({ text: '/admin fechar' }))

	assert.deepEqual(apagadas, [])
	assert.equal(calls.length, 0, 'nem gasta chamada de metadata — evita abuso por repetição')
	assert.equal(logs.at(-1)?.result, 'no_action')
})
