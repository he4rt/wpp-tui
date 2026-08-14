import { test } from 'node:test'
import assert from 'node:assert/strict'
import P from 'pino'

import {
	runPairing,
	validatePairingNumber,
	resolvePairingInput,
	type PairingDeps,
} from '../src/pairing.js'

// logger silencioso: runPairing deriva filhos com .child, então precisa ser um pino de verdade.
const silentLogger = P({ level: 'silent' })

// fake socket controlável: capturamos o callback de ev.process e o disparamos manualmente, no
// mesmo espírito de tests/collector/core.test.ts.
function makeFakeSocket(opts: { code?: string; requestThrows?: boolean; user?: { id: string } } = {}) {
	let processCb: ((events: Record<string, any>) => unknown) | null = null
	const calls = { end: 0, requested: [] as string[] }
	const sock: any = {
		user: opts.user,
		ev: {
			process(cb: (events: Record<string, any>) => unknown) {
				processCb = cb
			},
		},
		async requestPairingCode(number: string) {
			calls.requested.push(number)
			if (opts.requestThrows) throw new Error('boom')
			return opts.code ?? 'ABCD1234'
		},
		end() {
			calls.end += 1
		},
	}
	const emit = async (events: Record<string, any>) => {
		for (let i = 0; i < 100 && !processCb; i++) await new Promise((r) => setImmediate(r))
		assert.ok(processCb, 'ev.process não foi registrado')
		await processCb!(events)
	}
	return { sock, calls, emit }
}

// estado de auth fake: shape mínimo que makeCacheableSignalKeyStore aceita (keys com get/set).
function fakeAuthState(registered: boolean) {
	let saveCredsCalls = 0
	const state = {
		creds: { registered },
		keys: { get: async () => ({}), set: async () => {} },
	}
	const loadAuthState = (async () => ({
		state,
		saveCreds: async () => {
			saveCredsCalls += 1
		},
	})) as unknown as PairingDeps['loadAuthState']
	return { loadAuthState, saveCredsCalls: () => saveCredsCalls }
}

const fetchVersion = (async () => ({ version: [2, 3000, 0] })) as unknown as PairingDeps['fetchVersion']

// deps-base: injeta socket/auth/versão/relógio/streams; sem rede, sem disco real.
function baseDeps(over: Partial<PairingDeps> & { sock?: any } = {}): PairingDeps {
	const auth = fakeAuthState(false)
	return {
		number: '5511999999999',
		force: false,
		authDir: '/tmp/does-not-matter',
		logger: silentLogger,
		baileysLogger: silentLogger,
		makeSocket: over.sock ? ((() => over.sock) as any) : undefined,
		loadAuthState: auth.loadAuthState,
		fetchVersion,
		writeCode: () => {},
		...over,
	}
}

test('validatePairingNumber: aceita dígitos com DDI, rejeita não-dígitos e ausência', () => {
	assert.equal(validatePairingNumber('5511999999999'), '5511999999999')
	assert.equal(validatePairingNumber(' 5511999999999 '), '5511999999999')
	assert.equal(validatePairingNumber('+55 (11) 99999-9999'), null)
	assert.equal(validatePairingNumber('55-11-99999'), null)
	assert.equal(validatePairingNumber('abc'), null)
	assert.equal(validatePairingNumber(''), null)
	assert.equal(validatePairingNumber(undefined), null)
	assert.equal(validatePairingNumber('123'), null) // curto demais
})

test('resolvePairingInput: número do argv > env; detecta --force', () => {
	assert.deepEqual(resolvePairingInput(['--pair', '5511'], {}), { number: '5511', force: false })
	assert.deepEqual(resolvePairingInput(['--pair', '--force'], { PAIR_NUMBER: '99' }), { number: '99', force: true })
	assert.deepEqual(resolvePairingInput(['--pair'], {}), { number: undefined, force: false })
})

test('happy path: imprime o código no stdout, grava a sessão no open e sai 0', async () => {
	const fake = makeFakeSocket({ code: 'WXYZ7890', user: { id: '55@s.whatsapp.net' } })
	const auth = fakeAuthState(false)
	let printed: string | null = null
	const codeP = runPairing(
		baseDeps({
			sock: fake.sock,
			loadAuthState: auth.loadAuthState,
			writeCode: (c) => {
				printed = c
			},
		}),
	)

	// o 1º qr dispara o requestPairingCode; depois o open grava a sessão.
	await fake.emit({ 'connection.update': { qr: '2@ref' } })
	await fake.emit({ 'connection.update': { connection: 'open' } })
	await fake.emit({ 'creds.update': {} })

	const exit = await codeP
	assert.equal(exit, 0)
	assert.equal(printed, 'WXYZ7890')
	assert.deepEqual(fake.calls.requested, ['5511999999999'])
	assert.ok(auth.saveCredsCalls() >= 1, 'saveCreds deveria ter sido chamado no open')
	assert.equal(fake.calls.end, 1)
})

test('número inválido: sai != 0 sem abrir socket (makeSocket nunca chamado)', async () => {
	let madeSocket = false
	const exit = await runPairing(
		baseDeps({
			number: '+55 (11) 99999-9999',
			makeSocket: (() => {
				madeSocket = true
				return {} as any
			}) as any,
		}),
	)
	assert.equal(exit, 1)
	assert.equal(madeSocket, false)
})

test('argumento ausente E env ausente: sai != 0 sem abrir socket', async () => {
	let madeSocket = false
	const { number } = resolvePairingInput(['--pair'], {}) // undefined
	const exit = await runPairing(
		baseDeps({
			number,
			makeSocket: (() => {
				madeSocket = true
				return {} as any
			}) as any,
		}),
	)
	assert.equal(exit, 1)
	assert.equal(madeSocket, false)
})

test('timeout de 120s sem parear: sai != 0 (timer injetado dispara na hora)', async () => {
	const fake = makeFakeSocket()
	const auth = fakeAuthState(false)
	let fired: (() => void) | null = null
	const exit = await runPairing(
		baseDeps({
			sock: fake.sock,
			loadAuthState: auth.loadAuthState,
			timeoutMs: 120_000,
			// timer injetado: captura o callback e dispara imediatamente, sem esperar 120s reais.
			setTimer: ((fn: () => void) => {
				fired = fn
				fired()
				return { unref() {} } as any
			}) as any,
			clearTimer: (() => {}) as any,
		}),
	)
	assert.equal(exit, 1)
	assert.equal(fake.calls.end, 1)
})

test('sessão já registrada sem --force: recusa, sai != 0 e NÃO chama requestPairingCode', async () => {
	const fake = makeFakeSocket()
	const auth = fakeAuthState(true) // registered
	let madeSocket = false
	const exit = await runPairing(
		baseDeps({
			loadAuthState: auth.loadAuthState,
			force: false,
			makeSocket: (() => {
				madeSocket = true
				return fake.sock
			}) as any,
		}),
	)
	assert.equal(exit, 1)
	assert.equal(madeSocket, false, 'não deveria abrir socket com sessão registrada e sem --force')
	assert.deepEqual(fake.calls.requested, [], 'requestPairingCode não deveria ser chamado')
})

test('sessão já registrada com --force: descarta o authDir e prossegue com o pareamento', async () => {
	const fake = makeFakeSocket({ code: 'FORCE123' })
	const auth = fakeAuthState(true) // registered
	let removed: string | null = null
	let printed: string | null = null
	const codeP = runPairing(
		baseDeps({
			sock: fake.sock,
			loadAuthState: auth.loadAuthState,
			force: true,
			rmAuthDir: (dir) => {
				removed = dir
			},
			writeCode: (c) => {
				printed = c
			},
		}),
	)

	await fake.emit({ 'connection.update': { qr: '2@ref' } })
	await fake.emit({ 'connection.update': { connection: 'open' } })

	const exit = await codeP
	assert.equal(exit, 0)
	assert.ok(removed, 'authDir deveria ter sido descartado com --force')
	assert.equal(printed, 'FORCE123')
	assert.deepEqual(fake.calls.requested, ['5511999999999'])
})

test('--force com dir sujo mas NÃO registrado: descarta o authDir mesmo assim', async () => {
	const fake = makeFakeSocket({ code: 'DIRTY123' })
	const auth = fakeAuthState(false) // NÃO registrado, mas force deve limpar do mesmo jeito
	let removed: string | null = null
	const codeP = runPairing(
		baseDeps({
			sock: fake.sock,
			loadAuthState: auth.loadAuthState,
			force: true,
			rmAuthDir: (dir) => {
				removed = dir
			},
		}),
	)

	await fake.emit({ 'connection.update': { qr: '2@ref' } })
	await fake.emit({ 'connection.update': { connection: 'open' } })

	const exit = await codeP
	assert.equal(exit, 0)
	assert.ok(removed, 'authDir deveria ser descartado com --force mesmo sem sessão registrada')
	assert.deepEqual(fake.calls.requested, ['5511999999999'])
})

test('requestPairingCode falha: sai != 0 e encerra o socket', async () => {
	const fake = makeFakeSocket({ requestThrows: true })
	const auth = fakeAuthState(false)
	const codeP = runPairing(baseDeps({ sock: fake.sock, loadAuthState: auth.loadAuthState }))
	// o qr dispara o requestPairingCode, que lança → falha imediata.
	await fake.emit({ 'connection.update': { qr: '2@ref' } })
	const exit = await codeP
	assert.equal(exit, 1)
	assert.equal(fake.calls.end, 1)
})

test('close com restartRequired (515) pós-code: reconecta e sai 0 no open seguinte', async () => {
	const fake = makeFakeSocket({ code: 'RSTX0001' })
	const auth = fakeAuthState(false)
	const codeP = runPairing(baseDeps({ sock: fake.sock, loadAuthState: auth.loadAuthState }))

	// o qr dispara o requestPairingCode; o code é solicitado UMA vez só.
	await fake.emit({ 'connection.update': { qr: '2@ref' } })
	// Baileys fecha com restartRequired logo após o code ser aceito; o comando deve reconectar…
	await fake.emit({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } } })
	// …e o open subsequente conclui com exit 0.
	await fake.emit({ 'connection.update': { connection: 'open' } })

	const exit = await codeP
	assert.equal(exit, 0)
	// o code foi solicitado UMA vez só (não re-solicitado no restart).
	assert.deepEqual(fake.calls.requested, ['5511999999999'])
})

test('connection close antes do open: sai != 0', async () => {
	const fake = makeFakeSocket()
	const auth = fakeAuthState(false)
	const codeP = runPairing(baseDeps({ sock: fake.sock, loadAuthState: auth.loadAuthState }))

	await fake.emit({ 'connection.update': { connection: 'close', lastDisconnect: { error: new Error('nope') } } })

	const exit = await codeP
	assert.equal(exit, 1)
})
