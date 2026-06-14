import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import P from 'pino'

// IMPORTANTE: event-logger/group-cache/retention resolvem seus caminhos (logs/, group-metadata.json)
// no momento do import, contra o cwd. Então trocamos o cwd p/ um tmp ANTES do import dinâmico do núcleo,
// deixando todos os efeitos de disco isolados num diretório descartável.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'))
const repoCwd = process.cwd()
process.chdir(tmpDir)

// força o fallback offline de fetchLatestBaileysVersion (sem rede no teste).
const realFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch

const { startCollectorCore } = await import('../../src/collector/core.js')

process.on('exit', () => {
	globalThis.fetch = realFetch
	try { process.chdir(repoCwd) } catch {}
	try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// logger silencioso: o núcleo deriva filhos com .child, então precisa ser um pino de verdade.
const silentLogger = P({ level: 'silent' })

// fake socket controlável: capturamos o callback de ev.process e o disparamos manualmente.
function makeFakeSocket(opts: {
	user?: { id: string; name?: string }
	groups?: Record<string, any>
} = {}) {
	let processCb: ((events: Record<string, unknown>) => unknown) | null = null
	const calls = {
		end: 0,
		sent: [] as Array<{ jid: string; text: string }>,
		fetchedGroups: 0,
	}
	const sock: any = {
		user: opts.user,
		ev: {
			process(cb: (events: Record<string, unknown>) => unknown) {
				processCb = cb
			},
		},
		async groupFetchAllParticipating() {
			calls.fetchedGroups += 1
			return opts.groups ?? {}
		},
		async sendMessage(jid: string, content: { text: string }) {
			calls.sent.push({ jid, text: content.text })
		},
		end() {
			calls.end += 1
		},
	}
	// emit: dispara o loop de ev.process com o lote de eventos informado.
	const emit = async (events: Record<string, unknown>) => {
		// connect() é async (await useMultiFileAuthState + fetchLatestBaileysVersion); damos uns ticks.
		for (let i = 0; i < 100 && !processCb; i++) await new Promise((r) => setImmediate(r))
		assert.ok(processCb, 'ev.process não foi registrado')
		await processCb!(events)
	}
	return { sock, calls, emit }
}

const makeFakeMakeSocket = (sock: any) => (() => sock) as any

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

test('repassa cada evento p/ saveEvent (trilha NDJSON), router e onEvent', async () => {
	const fake = makeFakeSocket()
	const seen: Array<[string, unknown]> = []
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		onEvent: (name, data) => seen.push([name, data]),
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	await fake.emit({ 'chats.update': [{ id: '123@g.us' }] })

	// onEvent recebeu o evento
	assert.deepEqual(seen, [['chats.update', [{ id: '123@g.us' }]]])
	// saveEvent gravou a trilha crua em logs/<evento>/<data>.json (cwd = tmp)
	const dir = path.join(tmpDir, 'logs', 'chats.update')
	assert.ok(fs.existsSync(dir), 'pasta de log do evento deveria existir')
	const files = fs.readdirSync(dir)
	assert.equal(files.length, 1)
	const ndjson = fs.readFileSync(path.join(dir, files[0]), 'utf-8').trim()
	assert.match(ndjson, /"event":"chats.update"/)

	await handle.stop()
})

test('connection.update: open dispara onStatus(connected,{me}) e busca metadata dos grupos', async () => {
	const fake = makeFakeSocket({
		user: { id: '55@s.whatsapp.net', name: 'Daniel' },
		groups: {
			'g1@g.us': { id: 'g1@g.us', subject: 'Grupo Um', participants: [{ id: 'a@x', admin: 'admin' }] },
		},
	})
	const statuses: Array<{ s: string; me?: string }> = []
	const events: string[] = []
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		onStatus: (s, info) => statuses.push({ s, me: info?.me }),
		onEvent: (name) => events.push(name),
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	await fake.emit({ 'connection.update': { connection: 'open' } })
	// groupFetchAllParticipating roda em background — espera os microtasks resolverem.
	await flush()

	assert.deepEqual(statuses, [{ s: 'connected', me: 'Daniel' }])
	assert.equal(fake.calls.fetchedGroups, 1)
	// metadata sintética repassada via onEvent
	assert.ok(events.includes('groups.metadata'), 'deveria emitir groups.metadata pra UI')
	// persistida no cache do grupo
	const cache = JSON.parse(fs.readFileSync(path.join(tmpDir, 'logs', 'group-metadata.json'), 'utf-8'))
	assert.equal(cache['g1@g.us'].subject, 'Grupo Um')

	await handle.stop()
})

test('connection.update: connecting e qr propagam via onStatus/onQr', async () => {
	const fake = makeFakeSocket()
	const statuses: string[] = []
	let qr: string | null = null
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		onStatus: (s) => statuses.push(s),
		onQr: (q) => { qr = q },
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	await fake.emit({ 'connection.update': { connection: 'connecting' } })
	await fake.emit({ 'connection.update': { qr: 'QR-CODE-DATA' } })

	assert.deepEqual(statuses, ['connecting'])
	assert.equal(qr, 'QR-CODE-DATA')

	await handle.stop()
})

test('loggedOut limpa o authDir e reconecta', async () => {
	const fake = makeFakeSocket()
	const authDir = path.join(tmpDir, 'baileys_auth_info')
	const statuses: string[] = []
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		onStatus: (s) => statuses.push(s),
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	// useMultiFileAuthState cria o dir na conexão inicial — espera-o existir.
	for (let i = 0; i < 100 && !fs.existsSync(authDir); i++) await new Promise((r) => setImmediate(r))
	assert.ok(fs.existsSync(authDir), 'authDir deveria ter sido criado pelo connect inicial')

	// DisconnectReason.loggedOut === 401
	await fake.emit({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } } })

	assert.ok(!fs.existsSync(authDir), 'authDir deveria ter sido apagado no loggedOut')
	// disparou uma tentativa de reconexão (onStatus connecting)
	assert.ok(statuses.includes('connecting'))

	await handle.stop()
})

test('webhook != null liga o coletor: cria o outbox.db', async () => {
	const fake = makeFakeSocket()
	const outboxPath = path.join(tmpDir, 'collector-on.db')
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'collector-on.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: { url: 'http://localhost:9/whatsapp', secret: 's3cr3t' },
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	assert.ok(fs.existsSync(outboxPath), 'o outbox.db deveria ter sido criado quando o coletor está ligado')

	// reação num grupo → o router extrai e enfileira (chat_jid é grupo); não deve lançar.
	await fake.emit({
		'messages.reaction': [
			{ key: { remoteJid: 'g1@g.us', id: 'M1', participant: 'a@x' }, reaction: { text: '👍', key: { id: 'TARGET' } } },
		],
	})

	// enquanto o outbox (WAL) está aberto, o sidecar -wal existe.
	assert.ok(fs.existsSync(outboxPath + '-wal'), 'WAL deveria existir com o outbox aberto')

	await handle.stop()

	// stop() chama outbox.close() → o better-sqlite3 faz checkpoint e remove o sidecar -wal/-shm.
	// é um sinal observável de fora de que o outbox foi de fato fechado (requisito d).
	assert.ok(!fs.existsSync(outboxPath + '-wal'), 'stop() deveria ter fechado o outbox (sidecar -wal removido)')
})

test('webhook == null mantém o coletor desligado (sem outbox.db)', async () => {
	const fake = makeFakeSocket()
	const outboxPath = path.join(tmpDir, 'collector-off.db')
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'collector-off.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	await fake.emit({ 'messages.reaction': [{ key: { remoteJid: 'g1@g.us', id: 'M1' }, reaction: { text: '👍' } }] })

	assert.ok(!fs.existsSync(outboxPath), 'sem webhook não deveria criar outbox.db')

	await handle.stop()
})

test('stop() encerra o socket e sendMessage delega ao socket', async () => {
	const fake = makeFakeSocket()
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	// garante que o connect inicial já registrou o socket.
	await fake.emit({})

	await handle.sendMessage('g1@g.us', 'olá')
	assert.deepEqual(fake.calls.sent, [{ jid: 'g1@g.us', text: 'olá' }])

	await handle.stop()
	assert.equal(fake.calls.end, 1)
})
