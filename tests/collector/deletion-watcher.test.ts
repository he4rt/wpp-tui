import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeletionWatcher, formatDeletion } from '../../src/collector/deletion-watcher.js'
import type { DeletionUpdate } from '../../src/collector/deletion-watcher.js'
import type { LoggedMessage, MessageLookup } from '../../src/collector/message-lookup.js'

const GRUPO = '120363000000000002@g.us'
const ADMIN = '100000000000001@lid'
const AUTOR = '100000000000004@lid'
const BOT_PN = '5500900000000@s.whatsapp.net'
const BOT_LID = '100000000000099@lid'

// evento de revogação: `key` é a mensagem apagada, `update.key` traz quem apagou.
const revoke = (opts: { group?: string; author?: string; by?: string; id?: string; stub?: number; fromMe?: boolean } = {}): DeletionUpdate => ({
	key: { remoteJid: opts.group ?? GRUPO, participant: opts.author ?? AUTOR, id: opts.id ?? 'MSG1' },
	update: {
		messageStubType: opts.stub ?? 1,
		key: { remoteJid: opts.group ?? GRUPO, participant: opts.by ?? ADMIN, id: 'REVOKE1', fromMe: opts.fromMe ?? false },
	},
})

const achou = (over: Partial<LoggedMessage> = {}): MessageLookup => ({
	async find() {
		return { text: 'olha esse link suspeito', pushName: 'Fulano', sentAt: '2026-08-19T14:02:11.000Z', kind: 'conversation', ...over }
	},
})
const naoAchou: MessageLookup = { async find() { return null } }

function harness(opts: { lookup?: MessageLookup } = {}) {
	const logs: Array<Record<string, unknown>> = []
	const publicados: string[] = []
	const watcher = createDeletionWatcher({
		logger: { info: (o) => logs.push(o) },
		lookup: opts.lookup ?? achou(),
		groupName: (jid) => (jid === GRUPO ? 'Grupo Geral' : jid),
		self: () => [BOT_PN, BOT_LID],
		publisher: { async send(text) { publicados.push(text) } },
	})
	return { watcher, logs, publicados, last: () => logs[logs.length - 1] }
}

// ---- o caso que motiva o registro ----

test('admin apaga a mensagem de um membro: registra quem apagou, de quem era e o conteúdo', async () => {
	const h = harness()
	await h.watcher.handle([revoke()])

	assert.equal(h.logs.length, 1)
	assert.equal(h.last().event, 'message_deleted')
	assert.equal(h.last().deletedBy, ADMIN)
	assert.equal(h.last().author, AUTOR)
	assert.equal(h.last().authorName, 'Fulano')
	assert.equal(h.last().group, GRUPO)
	assert.equal(h.last().groupName, 'Grupo Geral')
	assert.equal(h.last().messageId, 'MSG1')
	assert.equal(h.last().sentAt, '2026-08-19T14:02:11.000Z')
	assert.equal(h.last().text, 'olha esse link suspeito')
	assert.equal(h.last().recovered, true)

	assert.equal(h.publicados.length, 1, 'e vai também para o grupo de log')
	assert.match(h.publicados[0], /^🗑️ mensagem apagada por outra pessoa$/m)
})

// ---- o que NÃO entra na trilha ----

test('quem apaga a PRÓPRIA mensagem não é registrado (arrependimento não é moderação)', async () => {
	const h = harness()
	await h.watcher.handle([revoke({ by: AUTOR })])
	assert.deepEqual(h.logs, [])
	assert.deepEqual(h.publicados, [])
})

test('apagamento feito pelo próprio bot é ignorado (já auditado como comando)', async () => {
	const h = harness()
	await h.watcher.handle([revoke({ by: BOT_LID })])
	await h.watcher.handle([revoke({ by: BOT_PN })])
	await h.watcher.handle([revoke({ by: 'outro@lid', fromMe: true })])
	assert.deepEqual(h.logs, [], 'senão cada /ban geraria um registro duplicado de apagamento')
})

test('update que não é revogação é ignorado (status de entrega, estrela, edição)', async () => {
	const h = harness()
	await h.watcher.handle([revoke({ stub: 2 }), { key: { remoteJid: GRUPO, id: 'X' }, update: {} }])
	assert.deepEqual(h.logs, [])
})

test('apagamento em DM é ignorado (não é moderação de grupo)', async () => {
	const h = harness()
	await h.watcher.handle([revoke({ group: '5500900000001@s.whatsapp.net' })])
	assert.deepEqual(h.logs, [])
})

test('revogação sem autor ou sem quem apagou é ignorada (não dá para afirmar nada)', async () => {
	const h = harness()
	await h.watcher.handle([
		{ key: { remoteJid: GRUPO, id: 'M1' }, update: { messageStubType: 1, key: { participant: ADMIN } } },
		{ key: { remoteJid: GRUPO, participant: AUTOR, id: 'M2' }, update: { messageStubType: 1, key: {} } },
	])
	assert.deepEqual(h.logs, [])
})

// ---- conteúdo não recuperado ----

test('mensagem fora dos logs ainda é registrada, marcando que o conteúdo não veio', async () => {
	const h = harness({ lookup: naoAchou })
	await h.watcher.handle([revoke()])

	assert.equal(h.last().text, null)
	assert.equal(h.last().recovered, false)
	assert.equal(h.last().authorName, null)
	assert.equal(h.last().deletedBy, ADMIN, 'quem apagou de quem continua registrado')
	assert.match(h.publicados[0], /conteúdo: não recuperado — id MSG1/)
})

test('lookup que lança não derruba o registro', async () => {
	const h = harness({ lookup: { async find() { throw new Error('log ilegível') } } })
	await h.watcher.handle([revoke()])
	assert.equal(h.logs.length, 1)
	assert.equal(h.last().recovered, false)
})

test('handle nunca lança, mesmo com payload absurdo', async () => {
	const h = harness()
	await h.watcher.handle(null as unknown as DeletionUpdate[])
	await h.watcher.handle([null as unknown as DeletionUpdate])
	assert.deepEqual(h.logs, [])
})

test('texto longo é truncado no registro', async () => {
	const h = harness({ lookup: achou({ text: 'x'.repeat(900) }) })
	await h.watcher.handle([revoke()])
	assert.equal(String(h.last().text).length, 300)
})

// ---- formatação ----

test('formatDeletion: mensagem legível para o moderador que lê o grupo de log', () => {
	const text = formatDeletion({
		group: GRUPO,
		groupName: 'Grupo Geral',
		deletedBy: ADMIN,
		author: AUTOR,
		authorName: 'Fulano',
		messageId: 'MSG1',
		sentAt: '2026-08-19T14:02:11.000Z',
		text: 'olha esse link suspeito',
		kind: 'conversation',
	})

	assert.equal(
		text,
		[
			'🗑️ mensagem apagada por outra pessoa',
			'grupo: Grupo Geral',
			`apagou: ${ADMIN}`,
			`autor: Fulano · ${AUTOR}`,
			'enviada em: 2026-08-19T14:02:11.000Z',
			'conteúdo: olha esse link suspeito',
		].join('\n'),
	)
})

test('formatDeletion: mídia sem legenda diz o tipo do que foi apagado', () => {
	const text = formatDeletion({
		group: GRUPO, groupName: null, deletedBy: ADMIN, author: AUTOR, authorName: null,
		messageId: 'MSG9', sentAt: null, text: null, kind: 'audioMessage',
	})
	assert.match(text, /^grupo: 120363000000000002@g\.us$/m, 'sem nome conhecido, o JID cru')
	assert.match(text, /conteúdo: não recuperado \(audioMessage\) — id MSG9/)
})
