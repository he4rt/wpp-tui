import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectHeartbeat } from '../../src/collector/heartbeat.js'

function fakeOutbox(pending: number, dead: number, oldest: number | null) {
	return {
		count: () => pending,
		deadCount: () => dead,
		oldestPendingCreatedAt: () => oldest,
	}
}

test('collectHeartbeat reporta status, pendentes, dead e idade do mais antigo', () => {
	const now = 10_000
	const stats = collectHeartbeat(fakeOutbox(3, 1, 7_000), 'connected', now)
	assert.deepEqual(stats, { status: 'connected', pending: 3, dead: 1, oldestAgeMs: 3_000 })
})

test('collectHeartbeat: oldestAgeMs null quando não há pendentes', () => {
	const stats = collectHeartbeat(fakeOutbox(0, 0, null), 'connecting', 10_000)
	assert.equal(stats.oldestAgeMs, null)
})

test('collectHeartbeat nunca retorna idade negativa', () => {
	const stats = collectHeartbeat(fakeOutbox(1, 0, 20_000), 'connected', 10_000)
	assert.equal(stats.oldestAgeMs, 0)
})
