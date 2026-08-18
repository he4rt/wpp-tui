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
	// audit base injeta actor + group + result; extra é mesclado
	assert.deepEqual(logs.at(-1), { actor: ACTOR, group: GROUP, result: 'ok', n: 1 })
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
	assert.ok(logs.some((l) => l.result === 'handler_error'), 'deveria auditar handler_error')
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

function visibilityHarness(opts: { moderationGroupJid?: string | null; failDelete?: boolean } = {}) {
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
		domain: async ({ audit }) => audit('ok'),
	})

	return { handler, deleted, published, logs, last: () => logs[logs.length - 1] }
}

const pingUpsert = (group: string) => ({
	type: 'notify',
	messages: [{
		key: { remoteJid: group, participant: 'quem@lid', id: 'CMD1' },
		pushName: 'Fulano',
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
	assert.equal(h.published[0].deleted, true)
})

test('visibilidade: no grupo de moderação e no de log o comando NÃO é apagado', async () => {
	for (const group of [MOD_JID, LOG_JID]) {
		const h = visibilityHarness()
		await h.handler.handle(pingUpsert(group))
		assert.deepEqual(h.deleted, [], `não deveria apagar em ${group}`)
		assert.equal(h.last().deleted, false)
		assert.equal(h.published.length, 1, 'mas ainda reporta')
	}
})

test('visibilidade: sem MODERATION_GROUP_JID nada é apagado, mas o relatório continua', async () => {
	const h = visibilityHarness({ moderationGroupJid: null })
	await h.handler.handle(pingUpsert(PUBLICO))
	assert.deepEqual(h.deleted, [])
	assert.equal(h.published.length, 1)
})

test('visibilidade: falha ao apagar é logada e o comando roda mesmo assim', async () => {
	const h = visibilityHarness({ failDelete: true })
	await h.handler.handle(pingUpsert(PUBLICO))

	assert.equal(h.logs[0].result, 'delete_error')
	assert.equal(h.last().result, 'ok', 'o comando não é abortado por falha de revoke')
	assert.equal(h.last().deleted, false)
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
