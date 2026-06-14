import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installShutdown } from '../../src/collector/shutdown.js'

// EventEmitter falso com a forma de NodeJS.EventEmitter usada pelo módulo (on/removeListener).
function fakeProc(): EventEmitter {
	return new EventEmitter()
}

// Cede um macrotask (setTimeout 0) para drenar toda a fila de microtasks — inclui a adoção da
// promise rejeitada de stop(), que custa hops extras de microtask antes do handler de rejeição.
async function flush() {
	await new Promise((r) => setTimeout(r, 0))
}

test('SIGTERM chama stop() e então exit(0)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	let stopped = 0
	installShutdown({
		stop: () => { stopped++ },
		log: () => {},
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('SIGTERM')
	await flush()

	assert.equal(stopped, 1)
	assert.deepEqual(exits, [0])
})

test('SIGINT chama stop() e então exit(0)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	installShutdown({
		stop: () => {},
		log: () => {},
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('SIGINT')
	await flush()

	assert.deepEqual(exits, [0])
})

test('aguarda stop() assíncrono resolver antes de exit(0)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	let resolveStop!: () => void
	installShutdown({
		stop: () => new Promise<void>((r) => { resolveStop = r }),
		log: () => {},
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('SIGTERM')
	await flush()
	assert.deepEqual(exits, []) // ainda não saiu: stop() não resolveu

	resolveStop()
	await flush()
	assert.deepEqual(exits, [0])
})

test('dispara só uma vez mesmo recebendo sinais repetidos', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	let stopped = 0
	installShutdown({
		stop: () => { stopped++ },
		log: () => {},
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('SIGTERM')
	proc.emit('SIGINT')
	proc.emit('SIGTERM')
	await flush()

	assert.equal(stopped, 1)
	assert.deepEqual(exits, [0])
})

test('timer de força chama exit(1) quando stop() trava', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	const events: string[] = []
	installShutdown({
		stop: () => new Promise<void>(() => {}), // nunca resolve
		log: (e) => events.push(e),
		proc,
		exit: (c) => exits.push(c),
		forceMs: 5,
	})

	proc.emit('SIGTERM')
	await new Promise((r) => setTimeout(r, 20))

	assert.deepEqual(exits, [1])
	assert.ok(events.includes('shutdown_force_timeout'))
})

test('stop() que rejeita resulta em exit(1)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	const events: string[] = []
	installShutdown({
		stop: () => Promise.reject(new Error('falhou ao fechar')),
		log: (e) => events.push(e),
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('SIGTERM')
	await flush()

	assert.deepEqual(exits, [1])
	assert.ok(events.includes('shutdown_stop_error'))
})

test('uncaughtException loga e sai com exit(1)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	const events: string[] = []
	installShutdown({
		stop: () => {},
		log: (e) => events.push(e),
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('uncaughtException', new Error('boom'))
	await flush()

	assert.deepEqual(exits, [1])
	assert.ok(events.includes('uncaughtException'))
})

test('unhandledRejection loga e sai com exit(1)', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	const events: string[] = []
	installShutdown({
		stop: () => {},
		log: (e) => events.push(e),
		proc,
		exit: (c) => exits.push(c),
	})

	proc.emit('unhandledRejection', new Error('rejeitado'))
	await flush()

	assert.deepEqual(exits, [1])
	assert.ok(events.includes('unhandledRejection'))
})

test('uninstall remove os listeners: sinais posteriores não disparam shutdown', async () => {
	const proc = fakeProc()
	const exits: number[] = []
	let stopped = 0
	const uninstall = installShutdown({
		stop: () => { stopped++ },
		log: () => {},
		proc,
		exit: (c) => exits.push(c),
	})

	uninstall()
	proc.emit('SIGTERM')
	proc.emit('SIGINT')
	await flush()

	assert.equal(stopped, 0)
	assert.deepEqual(exits, [])
	assert.equal(proc.listenerCount('SIGTERM'), 0)
	assert.equal(proc.listenerCount('SIGINT'), 0)
	assert.equal(proc.listenerCount('uncaughtException'), 0)
	assert.equal(proc.listenerCount('unhandledRejection'), 0)
})
