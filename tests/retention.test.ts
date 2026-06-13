import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pruneOldEventLogs, pruneMessageStore } from '../src/retention.js'

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-ret-'))
}

test('pruneOldEventLogs apaga por data além do limite e mantém recentes', () => {
	const dir = tmp()
	const ev = path.join(dir, 'presence.update')
	fs.mkdirSync(ev, { recursive: true })
	fs.writeFileSync(path.join(ev, '2026-05-01.json'), 'x') // 20 dias
	fs.writeFileSync(path.join(ev, '2026-05-20.json'), 'x') // 1 dia
	const removed = pruneOldEventLogs(7, new Date('2026-05-21T00:00:00Z'), dir)
	assert.equal(removed, 1)
	assert.equal(fs.existsSync(path.join(ev, '2026-05-01.json')), false)
	assert.equal(fs.existsSync(path.join(ev, '2026-05-20.json')), true)
})

test('pruneOldEventLogs com days<=0 não apaga nada (compat)', () => {
	const dir = tmp()
	const ev = path.join(dir, 'x')
	fs.mkdirSync(ev, { recursive: true })
	fs.writeFileSync(path.join(ev, '2000-01-01.json'), 'x')
	assert.equal(pruneOldEventLogs(0, new Date(), dir), 0)
	assert.equal(fs.existsSync(path.join(ev, '2000-01-01.json')), true)
})

test('pruneOldEventLogs ignora cache na raiz, dir message-store e nomes fora do padrão', () => {
	const dir = tmp()
	fs.writeFileSync(path.join(dir, 'group-metadata.json'), 'x') // cache na raiz
	const ms = path.join(dir, 'message-store')
	fs.mkdirSync(ms)
	fs.writeFileSync(path.join(ms, 'a_b.json'), 'x') // dir ignorado aqui
	const ev = path.join(dir, 'messages.upsert')
	fs.mkdirSync(ev)
	fs.writeFileSync(path.join(ev, 'naodata.json'), 'x') // nome fora do padrão data
	const removed = pruneOldEventLogs(1, new Date('2030-01-01T00:00:00Z'), dir)
	assert.equal(removed, 0)
	assert.equal(fs.existsSync(path.join(dir, 'group-metadata.json')), true)
	assert.equal(fs.existsSync(path.join(ms, 'a_b.json')), true)
	assert.equal(fs.existsSync(path.join(ev, 'naodata.json')), true)
})

test('pruneMessageStore apaga por mtime antigo e mantém recente', () => {
	const dir = tmp()
	const ms = path.join(dir, 'message-store')
	fs.mkdirSync(ms, { recursive: true })
	const old = path.join(ms, 'old.json')
	const fresh = path.join(ms, 'fresh.json')
	fs.writeFileSync(old, 'x')
	fs.writeFileSync(fresh, 'x')
	const now = new Date('2026-05-21T00:00:00Z')
	const oldSecs = (now.getTime() - 10 * 86_400_000) / 1000
	fs.utimesSync(old, oldSecs, oldSecs)
	const removed = pruneMessageStore(3, now, ms)
	assert.equal(removed, 1)
	assert.equal(fs.existsSync(old), false)
	assert.equal(fs.existsSync(fresh), true)
})

test('pruneMessageStore com diretório inexistente retorna 0', () => {
	assert.equal(pruneMessageStore(3, new Date(), path.join(os.tmpdir(), 'nao-existe-xyz-123')), 0)
})
