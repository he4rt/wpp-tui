import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModerationConfig, isPrivateAdminGroup, shouldDeleteCommand } from '../../src/collector/moderation-config.js'

const MOD = '120363000000000004@g.us'
const LOG = '120363000000000006@g.us'
const PUBLICO = '120363000000000002@g.us'

test('resolveModerationConfig: lê os dois JIDs do ambiente', () => {
	const c = resolveModerationConfig({ MODERATION_GROUP_JID: MOD, LOG_GROUP_JID: LOG })
	assert.deepEqual(c, { moderationGroupJid: MOD, logGroupJid: LOG })
})

test('resolveModerationConfig: completa o sufixo @g.us e tolera espaços', () => {
	const c = resolveModerationConfig({ MODERATION_GROUP_JID: '  120363000000000004 ', LOG_GROUP_JID: `${LOG}\n` })
	assert.equal(c.moderationGroupJid, MOD)
	assert.equal(c.logGroupJid, LOG)
})

test('resolveModerationConfig: ausente ou vazio vira null', () => {
	assert.deepEqual(resolveModerationConfig({}), { moderationGroupJid: null, logGroupJid: null })
	assert.deepEqual(resolveModerationConfig({ MODERATION_GROUP_JID: '   ', LOG_GROUP_JID: '' }), {
		moderationGroupJid: null,
		logGroupJid: null,
	})
})

test('isPrivateAdminGroup: moderação e log são privados; o resto não', () => {
	const c = resolveModerationConfig({ MODERATION_GROUP_JID: MOD, LOG_GROUP_JID: LOG })
	assert.equal(isPrivateAdminGroup(c, MOD), true)
	assert.equal(isPrivateAdminGroup(c, LOG), true)
	assert.equal(isPrivateAdminGroup(c, PUBLICO), false)
})

test('shouldDeleteCommand: apaga fora dos grupos privados de admin', () => {
	const c = resolveModerationConfig({ MODERATION_GROUP_JID: MOD, LOG_GROUP_JID: LOG })
	assert.equal(shouldDeleteCommand(c, PUBLICO), true)
	assert.equal(shouldDeleteCommand(c, MOD), false)
	assert.equal(shouldDeleteCommand(c, LOG), false)
})

test('shouldDeleteCommand: sem MODERATION_GROUP_JID não apaga NADA (fail-safe)', () => {
	const c = resolveModerationConfig({ LOG_GROUP_JID: LOG })
	assert.equal(shouldDeleteCommand(c, PUBLICO), false)
	assert.equal(shouldDeleteCommand(c, LOG), false)
})
