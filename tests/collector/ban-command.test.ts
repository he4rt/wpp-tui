import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBanCommand, messageText, resolveBanTarget } from '../../src/collector/ban-command.js'
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

test('resolveBanTarget: reply usa contextInfo.participant', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'victim@s.whatsapp.net', stanzaId: 'S1' } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: menção usa o primeiro mentionedJid', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @x', contextInfo: { mentionedJid: ['victim@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: reply tem prioridade sobre menção', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @y', contextInfo: { participant: 'reply@s.whatsapp.net', stanzaId: 'S1', mentionedJid: ['mention@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'reply@s.whatsapp.net')
})

test('resolveBanTarget: sem reply e sem menção → null', () => {
	assert.equal(resolveBanTarget({ message: { conversation: '/ban' } }), null)
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: {} } } }), null)
	// participant sem stanzaId não conta como reply
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'x@s.whatsapp.net' } } } }), null)
})
