import { test } from 'node:test'
import assert from 'node:assert/strict'
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
