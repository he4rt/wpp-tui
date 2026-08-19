import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReportEntry } from '../../src/collector/moderation-report.js'
import { createCommandHandler, requireGroupAdmin } from '../../src/collector/command-handler.js'
import type { CommandContext } from '../../src/collector/command-handler.js'
import type { CmdUpsert } from '../../src/collector/command-core.js'

const GROUP = 'g@g.us'
const ACTOR = 'actor@s.whatsapp.net'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// upsert com uma única mensagem de comando (texto configurável).
function upsert(opts: { type?: string; group?: string; actor?: string; text?: string } = {}): CmdUpsert {
	return {
		type: opts.type ?? 'notify',
		messages: [{
			key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ACTOR, id: 'CMD1' },
			pushName: 'Fulano',
			messageTimestamp: 1_756_000_000,
			message: { extendedTextMessage: { text: opts.text ?? '/ping' } },
		}],
	}
}

// ---- createCommandHandler ----

test('createCommandHandler: ignora upsert que não é notify', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ type: 'append' }))
	assert.equal(called, 0)
})

test('createCommandHandler: ignora DM (não-@g.us)', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ group: '5511@s.whatsapp.net' }))
	assert.equal(called, 0)
})

test('createCommandHandler: ignora comando que não casa o name', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ text: '/pong' }))
	assert.equal(called, 0)
})

test('createCommandHandler: casa /ping e !ping e injeta ctx (actor, sock, audit)', async () => {
	const { logs, logger } = fakeLogger()
	const seen: Array<CommandContext<{ tag: string }>> = []
	const h = createCommandHandler({
		name: 'ping',
		sock: { tag: 'S' },
		logger,
		domain: async (ctx) => { seen.push(ctx); ctx.audit('ok', { n: 1 }) },
	})
	await h.handle(upsert({ text: '!ping' }))
	assert.equal(seen.length, 1)
	assert.equal(seen[0].groupJid, GROUP)
	assert.equal(seen[0].actor, ACTOR)
	assert.deepEqual(seen[0].sock, { tag: 'S' })
	// audit base injeta a identidade inteira da tentativa; extra é mesclado
	assert.deepEqual(logs.at(-1), {
		command: 'ping',
		actor: ACTOR,
		actorName: 'Fulano',
		group: GROUP,
		messageId: 'CMD1',
		sentAt: '2025-08-24T01:46:40.000Z',
		text: '!ping',
		result: 'ok',
		n: 1,
	})
})

test('createCommandHandler: uma linha basta para saber quem/onde/o quê/quando (auditoria autossuficiente)', async () => {
	const { logs, logger } = fakeLogger()
	const h = createCommandHandler({
		name: 'ping', sock: {}, logger,
		domain: async ({ audit }) => audit('ok'),
	})
	await h.handle(upsert({ text: '/ping alguem  motivo qualquer' }))

	const l = logs.at(-1)!
	assert.equal(l.command, 'ping')
	assert.equal(l.actor, ACTOR, 'quem')
	assert.equal(l.actorName, 'Fulano', 'quem, em nome legível')
	assert.equal(l.group, GROUP, 'onde')
	assert.equal(l.messageId, 'CMD1', 'qual mensagem — a única ponte para o evento cru')
	assert.equal(l.sentAt, '2025-08-24T01:46:40.000Z', 'quando foi digitado')
	assert.equal(l.text, '/ping alguem  motivo qualquer', 'o que foi digitado, cru')
})

test('createCommandHandler: texto longo é truncado no log (a trilha não é arquivo de mensagens)', async () => {
	const { logs, logger } = fakeLogger()
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async ({ audit }) => audit('ok') })
	await h.handle(upsert({ text: `/ping ${'x'.repeat(500)}` }))
	assert.equal(String(logs.at(-1)!.text).length, 200)
})

test('createCommandHandler: mensagem sem timestamp registra sentAt null (sem inventar horário)', async () => {
	const { logs, logger } = fakeLogger()
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async ({ audit }) => audit('ok') })
	await h.handle({
		type: 'notify',
		messages: [{ key: { remoteJid: GROUP, participant: ACTOR, id: 'CMD1' }, message: { conversation: '/ping' } }],
	})
	assert.equal(logs.at(-1)!.sentAt, null)
})

test('createCommandHandler: domain que lança → handler_error (best-effort); 2ª msg do lote ainda roda', async () => {
	const { logs, logger } = fakeLogger()
	const processed: string[] = []
	const u: CmdUpsert = {
		type: 'notify',
		messages: [
			{ key: { remoteJid: GROUP, participant: ACTOR, id: 'M1' }, message: { extendedTextMessage: { text: '/ping' } } },
			{ key: { remoteJid: GROUP, participant: ACTOR, id: 'M2' }, message: { extendedTextMessage: { text: '/ping' } } },
		],
	}
	let n = 0
	const h = createCommandHandler({
		name: 'ping', sock: {}, logger,
		domain: async () => { n++; processed.push('m' + n); if (n === 1) throw new Error('boom') },
	})
	await h.handle(u) // não deve lançar
	assert.equal(processed.length, 2)
	const erro = logs.find((l) => l.result === 'handler_error')
	assert.ok(erro, 'deveria auditar handler_error')
	// sem contexto, um handler_error é impossível de investigar
	assert.equal(erro!.command, 'ping')
	assert.equal(erro!.group, GROUP)
	assert.equal(erro!.actor, ACTOR)
	assert.equal(erro!.messageId, 'M1')
	assert.match(String(erro!.err), /boom/)
})

// ---- requireGroupAdmin ----

function auditSpy() {
	const logs: Array<{ result: string; extra: Record<string, unknown> }> = []
	const audit = (result: string, extra: Record<string, unknown> = {}) => { logs.push({ result, extra }) }
	return { logs, audit }
}

test('requireGroupAdmin: groupMetadata lança → metadata_error, retorna null', async () => {
	const { logs, audit } = auditSpy()
	const sock = { groupMetadata: async () => { throw new Error('meta boom') } }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.equal(meta, null)
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('requireGroupAdmin: autor não-admin → not_admin, retorna null', async () => {
	const { logs, audit } = auditSpy()
	const sock = { groupMetadata: async () => ({ id: GROUP, participants: [{ id: ACTOR, admin: null }] }) }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.equal(meta, null)
	assert.equal(logs.at(-1)?.result, 'not_admin')
	assert.equal(logs.at(-1)?.extra.member, true, 'membro comum ≠ autor ausente da metadata')
})

test('requireGroupAdmin: autor que nem está na metadata → not_admin com member:false', async () => {
	const { logs, audit } = auditSpy()
	const sock = { groupMetadata: async () => ({ id: GROUP, participants: [{ id: 'outro@lid', admin: null }] }) }
	await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.equal(logs.at(-1)?.extra.member, false)
})

test('requireGroupAdmin: apagar segue o status — admin apaga, não-admin não', async () => {
	for (const [admin, esperado] of [['admin', 1], [null, 0]] as const) {
		const { audit } = auditSpy()
		let apagou = 0
		const sock = { groupMetadata: async () => ({ id: GROUP, participants: [{ id: ACTOR, admin }] }) }
		await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit, deleteCommand: async () => { apagou++ } })
		assert.equal(apagou, esperado, `admin=${admin}`)
	}
})

test('requireGroupAdmin: autor admin → retorna a meta, sem auditar', async () => {
	const { logs, audit } = auditSpy()
	const expected = { id: GROUP, participants: [{ id: ACTOR, admin: 'admin' as const }] }
	const sock = { groupMetadata: async () => expected }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.deepEqual(meta, expected)
	assert.equal(logs.length, 0)
})

// ---- visibilidade: apagar o comando + relatório no grupo de log ----

const MOD_JID = '120363000000000004@g.us'
const LOG_JID = '120363000000000006@g.us'
const PUBLICO = '120363000000000002@g.us'

// `authorized: false` simula o domínio que NÃO passou pela autorização: ele audita sem nunca pedir
// para apagar — é o caminho de quem não pode moderar.
function visibilityHarness(opts: { moderationGroupJid?: string | null; failDelete?: boolean; authorized?: boolean } = {}) {
	const deleted: Array<{ jid: string; key: unknown }> = []
	const published: Array<Record<string, unknown>> = []
	const logs: Array<Record<string, unknown>> = []

	const visibility = {
		config: {
			moderationGroupJid: opts.moderationGroupJid === undefined ? MOD_JID : opts.moderationGroupJid,
			logGroupJid: LOG_JID,
		},
		deleter: {
			async sendMessage(jid: string, content: { delete: unknown }) {
				if (opts.failDelete) throw new Error('sem permissão')
				deleted.push({ jid, key: content.delete })
				return {}
			},
		},
		reporter: {
			async publish(entry: ReportEntry) {
				published.push(entry as unknown as Record<string, unknown>)
			},
		},
	}

	const handler = createCommandHandler({
		name: 'ping',
		sock: {},
		logger: { info: (obj: Record<string, unknown>) => logs.push(obj) },
		visibility,
		domain: async ({ audit, deleteCommand }) => {
			if (opts.authorized !== false) await deleteCommand()
			audit('ok')
		},
	})

	return { handler, deleted, published, logs, last: () => logs[logs.length - 1] }
}

const pingUpsert = (group: string) => ({
	type: 'notify',
	messages: [{
		key: { remoteJid: group, participant: 'quem@lid', id: 'CMD1' },
		pushName: 'Fulano',
		messageTimestamp: 1_756_000_000,
		message: { conversation: '/ping' },
	}],
})

test('visibilidade: comando é apagado em grupo comum e reportado no grupo de log', async () => {
	const h = visibilityHarness()
	await h.handler.handle(pingUpsert(PUBLICO))

	assert.deepEqual(h.deleted, [{ jid: PUBLICO, key: { remoteJid: PUBLICO, participant: 'quem@lid', id: 'CMD1' } }])
	assert.equal(h.last().deleted, true)
	assert.equal(h.published.length, 1)
	assert.equal(h.published[0].command, 'ping')
	assert.equal(h.published[0].actorName, 'Fulano')
	assert.equal(h.published[0].text, '/ping', 'o relatório mostra o que foi digitado')
	assert.equal(h.published[0].deleted, true)
})

test('visibilidade: no grupo de moderação e no de log o comando NÃO é apagado', async () => {
	for (const group of [MOD_JID, LOG_JID]) {
		const h = visibilityHarness()
		await h.handler.handle(pingUpsert(group))
		assert.deepEqual(h.deleted, [], `não deveria apagar em ${group}`)
		assert.equal(h.last().deleted, false)
		assert.equal(h.last().deleteSkip, 'private_admin_group', 'o log diz POR QUE não apagou')
		assert.equal(h.published.length, 1, 'mas ainda reporta')
	}
})

test('visibilidade: sem MODERATION_GROUP_JID nada é apagado, mas o relatório continua', async () => {
	const h = visibilityHarness({ moderationGroupJid: null })
	await h.handler.handle(pingUpsert(PUBLICO))
	assert.deepEqual(h.deleted, [])
	assert.equal(h.last().deleteSkip, 'moderation_group_unset', 'config ausente ≠ sala de admin')
	assert.equal(h.published.length, 1)
})

test('visibilidade: falha ao apagar é logada, reportada no grupo de log e o comando roda', async () => {
	const h = visibilityHarness({ failDelete: true })
	await h.handler.handle(pingUpsert(PUBLICO))

	assert.equal(h.logs[0].result, 'delete_error')
	assert.equal(h.logs[0].messageId, 'CMD1', 'o erro de revoke também precisa de contexto')
	assert.equal(h.last().result, 'ok', 'o comando não é abortado por falha de revoke')
	assert.equal(h.last().deleted, false)
	assert.equal(h.last().deleteSkip, 'delete_failed')
	// o bot ter perdido admin no grupo é acionável: não pode ficar só no journal
	assert.deepEqual(h.published.map((p) => p.result), ['delete_error', 'ok'])
})

test('visibilidade: comando de quem NÃO passou pela autorização não é apagado, mas é reportado', async () => {
	const h = visibilityHarness({ authorized: false })
	await h.handler.handle(pingUpsert(PUBLICO))

	assert.deepEqual(h.deleted, [], 'a mensagem de quem não pode moderar fica onde está')
	assert.equal(h.last().deleted, false)
	assert.equal(h.last().deleteSkip, 'not_authorized')
	assert.equal(h.published.length, 1, 'a tentativa continua indo para o grupo de log')
})

test('visibilidade: deleteCommand é idempotente (duas chamadas, uma revogação)', async () => {
	const deleted: Array<{ jid: string }> = []
	const handler = createCommandHandler({
		name: 'ping',
		sock: {},
		logger: { info: () => {} },
		visibility: {
			config: { moderationGroupJid: MOD_JID, logGroupJid: LOG_JID },
			deleter: { async sendMessage(jid: string) { deleted.push({ jid }); return {} } },
			reporter: { async publish() {} },
		},
		domain: async ({ audit, deleteCommand }) => { await deleteCommand(); await deleteCommand(); audit('ok') },
	})
	await handler.handle(pingUpsert(PUBLICO))
	assert.equal(deleted.length, 1)
})

test('visibilidade: mensagem que não é comando não é apagada nem reportada', async () => {
	const h = visibilityHarness()
	await h.handler.handle({
		type: 'notify',
		messages: [{ key: { remoteJid: PUBLICO, participant: 'quem@lid', id: 'X' }, message: { conversation: 'oi' } }],
	})
	assert.deepEqual(h.deleted, [])
	assert.deepEqual(h.published, [])
	assert.deepEqual(h.logs, [])
})

test('visibilidade: o journal registra o nome do grupo ao lado do JID', async () => {
	const deleted: Array<{ jid: string }> = []
	const logs: Array<Record<string, unknown>> = []
	const handler = createCommandHandler({
		name: 'ping',
		sock: {},
		logger: { info: (obj: Record<string, unknown>) => logs.push(obj) },
		visibility: {
			config: { moderationGroupJid: MOD_JID, logGroupJid: LOG_JID },
			deleter: { async sendMessage(jid: string) { deleted.push({ jid }); return {} } },
			reporter: { async publish() {} },
			groupName: (jid) => (jid === PUBLICO ? 'Grupo Geral' : jid),
		},
		domain: async ({ audit, deleteCommand }) => { await deleteCommand(); audit('ok') },
	})

	await handler.handle(pingUpsert(PUBLICO))
	assert.equal(logs[0].group, PUBLICO)
	assert.equal(logs[0].groupName, 'Grupo Geral')
})

test('visibilidade: sem resolvedor de nome, o journal fica como era (só o JID)', async () => {
	const h = visibilityHarness()
	await h.handler.handle(pingUpsert(PUBLICO))
	assert.equal(h.last().group, PUBLICO)
	assert.equal('groupName' in h.last(), false)
})
