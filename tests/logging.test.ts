import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createLoggers } from '../src/logging.js'

// Diretório temporário isolado por teste para os arquivos de log.
function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-log-'))
}

// O transport pino/file roda em worker thread (escrita assíncrona). Em vez de um sleep fixo
// e frágil, espera o arquivo aparecer com conteúdo até um deadline curto.
async function waitForFile(file: string, timeoutMs = 2000): Promise<string> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (fs.existsSync(file)) {
			const content = fs.readFileSync(file, 'utf8')
			if (content.length > 0) return content
		}
		if (Date.now() >= deadline) {
			throw new Error(`timeout esperando conteúdo em ${file}`)
		}
		await new Promise((r) => setTimeout(r, 10))
	}
}

// (a) Defaults: app em 'info', baileys em 'warn'.
test('níveis default: app=info e baileys=warn', () => {
	const { app, baileys } = createLoggers({})
	assert.equal(app.level, 'info')
	assert.equal(baileys.level, 'warn')
})

// (a) Overrides de nível são aplicados a cada logger.
test('overrides de nível são aplicados', () => {
	const { app, baileys } = createLoggers({ level: 'debug', baileysLevel: 'error' })
	assert.equal(app.level, 'debug')
	assert.equal(baileys.level, 'error')
})

// (b) app.level e baileys.level são independentes quando configurados diferentes.
test('app.level e baileys.level são independentes', () => {
	const { app, baileys } = createLoggers({ level: 'trace', baileysLevel: 'fatal' })
	assert.notEqual(app.level, baileys.level)
	assert.equal(app.level, 'trace')
	assert.equal(baileys.level, 'fatal')
})

// (c) O logger do Baileys carrega component:'baileys' nos bindings.
test('logger do baileys carrega component:"baileys" nos bindings', () => {
	const { app, baileys } = createLoggers({})
	assert.deepEqual(baileys.bindings(), { component: 'baileys' })
	// O app é a base: não fixa component (os chamadores derivam filhos com a tag).
	assert.equal(app.bindings().component, undefined)
})

// (c, bis) A tag component:'baileys' também aparece na linha emitida (não só no objeto bindings).
test('linha emitida pelo baileys inclui component:"baileys"', async () => {
	const dir = tmpDir()
	const file = path.join(dir, 'baileys.log')
	const { baileys } = createLoggers({ file, baileysLevel: 'warn' })
	baileys.warn('alerta de protocolo')

	const content = await waitForFile(file)
	const line = content.trim().split('\n').filter(Boolean).pop()!
	const parsed = JSON.parse(line)
	assert.equal(parsed.component, 'baileys')
	assert.equal(parsed.msg, 'alerta de protocolo')
})

// (d) Quando file está setado, o logger escreve naquele arquivo (e não em stdout).
test('quando file está setado, escreve no arquivo', async () => {
	const dir = tmpDir()
	const file = path.join(dir, 'app.log')
	const { app } = createLoggers({ file })
	app.info({ component: 'whatsapp' }, 'conectado')

	const content = await waitForFile(file)
	const line = content.trim().split('\n').filter(Boolean).pop()!
	const parsed = JSON.parse(line)
	assert.equal(parsed.msg, 'conectado')
	assert.equal(parsed.component, 'whatsapp')
})

// (d, bis) Os dois loggers compartilham o mesmo destino de arquivo.
test('app e baileys compartilham o mesmo arquivo de destino', async () => {
	const dir = tmpDir()
	const file = path.join(dir, 'shared.log')
	const { app, baileys } = createLoggers({ file, baileysLevel: 'warn' })
	app.info('linha-do-app')
	baileys.warn('linha-do-baileys')

	// Espera as duas linhas (o worker pode achatar em flushes separados).
	const deadline = Date.now() + 2000
	let lines: string[] = []
	for (;;) {
		if (fs.existsSync(file)) {
			lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
		}
		if (lines.length >= 2 || Date.now() >= deadline) break
		await new Promise((r) => setTimeout(r, 10))
	}
	const msgs = lines.map((l) => JSON.parse(l).msg)
	assert.ok(msgs.includes('linha-do-app'))
	assert.ok(msgs.includes('linha-do-baileys'))
})

// (e) Seleção pretty vs json não lança em nenhum dos caminhos.
test('seleção pretty não lança', () => {
	assert.doesNotThrow(() => {
		const { app, baileys } = createLoggers({ pretty: true })
		// Só construir e logar precisa ser seguro; o transport pretty é assíncrono.
		app.info('com pretty')
		baileys.warn('com pretty no baileys')
	})
})

test('seleção json (default) não lança', () => {
	assert.doesNotThrow(() => {
		const { app, baileys } = createLoggers({})
		app.info('json default')
		baileys.warn('json default no baileys')
	})
})
