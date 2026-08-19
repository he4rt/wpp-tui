import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, messageText, isAdmin, sentAtIso } from '../../src/collector/command-core.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseCommand: aceita prefixo / e !, normaliza nome e args', () => {
	assert.deepEqual(parseCommand('/ban'), { name: 'ban', args: [], rawArgs: [] })
	assert.deepEqual(parseCommand('!ban'), { name: 'ban', args: [], rawArgs: [] })
	assert.deepEqual(parseCommand('/admin on'), { name: 'admin', args: ['on'], rawArgs: ['on'] })
	assert.deepEqual(parseCommand('!admin OFF'), { name: 'admin', args: ['off'], rawArgs: ['OFF'] })
	assert.deepEqual(parseCommand(' /BAN @Fulano '), { name: 'ban', args: ['@fulano'], rawArgs: ['@Fulano'] })
})

test('parseCommand: rawArgs preserva o texto do motivo como foi digitado', () => {
	const cmd = parseCommand('/ban 5500900000002 Spam De Cripto')
	assert.deepEqual(cmd?.rawArgs, ['5500900000002', 'Spam', 'De', 'Cripto'])
	assert.deepEqual(cmd?.args, ['5500900000002', 'spam', 'de', 'cripto'])
})

test('parseCommand: rejeita o que não é comando', () => {
	for (const t of ['ban', 'oi /ban', '', 'oi', '#ban', '/']) {
		assert.equal(parseCommand(t), null, `deveria rejeitar: "${t}"`)
	}
})

test('messageText: conversation, extendedTextMessage e vazio', () => {
	assert.equal(messageText({ message: { conversation: '/ban' } }), '/ban')
	assert.equal(messageText({ message: { extendedTextMessage: { text: '/admin on' } } }), '/admin on')
	assert.equal(messageText({}), '')
	assert.equal(messageText({ message: {} } as CmdMessage), '')
})

test('isAdmin: admin/superadmin true; resto false', () => {
	assert.equal(isAdmin({ admin: 'admin' }), true)
	assert.equal(isAdmin({ admin: 'superadmin' }), true)
	assert.equal(isAdmin({ admin: null }), false)
	assert.equal(isAdmin(undefined), false)
})

test('sentAtIso: converte segundos UNIX (number e Long do protobuf)', () => {
	assert.equal(sentAtIso({ messageTimestamp: 1_756_000_000 }), '2025-08-24T01:46:40.000Z')
	assert.equal(sentAtIso({ messageTimestamp: { toNumber: () => 1_756_000_000 } }), '2025-08-24T01:46:40.000Z')
})

test('sentAtIso: sem timestamp utilizável devolve null (não inventa horário)', () => {
	assert.equal(sentAtIso({}), null)
	assert.equal(sentAtIso({ messageTimestamp: null }), null)
	assert.equal(sentAtIso({ messageTimestamp: 0 }), null)
	assert.equal(sentAtIso({ messageTimestamp: { toNumber: () => NaN } }), null)
})
