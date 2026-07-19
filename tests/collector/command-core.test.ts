import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, messageText, isAdmin } from '../../src/collector/command-core.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseCommand: aceita prefixo / e !, normaliza nome e args', () => {
	assert.deepEqual(parseCommand('/ban'), { name: 'ban', args: [] })
	assert.deepEqual(parseCommand('!ban'), { name: 'ban', args: [] })
	assert.deepEqual(parseCommand('/admin on'), { name: 'admin', args: ['on'] })
	assert.deepEqual(parseCommand('!admin OFF'), { name: 'admin', args: ['off'] })
	assert.deepEqual(parseCommand(' /BAN @Fulano '), { name: 'ban', args: ['@fulano'] })
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
