import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBanCommand, messageText } from '../../src/collector/ban-command.js'
import type { BanMessage } from '../../src/collector/ban-command.js'

test('parseBanCommand: aceita /ban como primeiro token (com reply ou menção)', () => {
	for (const t of ['/ban', ' /ban ', '/BAN', '/ban @Fulano', '/BAN @x']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
})

test('parseBanCommand: rejeita o que não é o comando', () => {
	for (const t of ['/bandido', 'ban', 'oi /ban', '', 'oi', '/banir']) {
		assert.equal(parseBanCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

test('messageText: lê conversation', () => {
	const msg: BanMessage = { message: { conversation: '/ban' } }
	assert.equal(messageText(msg), '/ban')
})

test('messageText: lê extendedTextMessage.text', () => {
	const msg: BanMessage = { message: { extendedTextMessage: { text: '/ban @x' } } }
	assert.equal(messageText(msg), '/ban @x')
})

test('messageText: sem texto → string vazia', () => {
	assert.equal(messageText({}), '')
	assert.equal(messageText({ message: {} }), '')
})
