import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox } from '../../src/collector/outbox.js'
import type { OutboxEvent } from '../../src/collector/types.js'

function event(eventId = 'E1'): OutboxEvent {
	return {
		event_id: eventId,
		body: { type: 'messages.upsert', chat_jid: '1@g.us', payload: { x: 1 } },
	}
}

test('enqueue grava; event_id idêntico deduplica na origem (INSERT OR IGNORE)', () => {
	const ob = createOutbox(':memory:')
	ob.enqueue(event('E1'))
	ob.enqueue(event('E1')) // mesmo event_id → ignorado, não duplica
	assert.equal(ob.count(), 1)
	ob.enqueue(event('E2'))
	assert.equal(ob.count(), 2)
	ob.close()
})

test('claimReady retorna body parseado, event_id e attempts', () => {
	const ob = createOutbox(':memory:')
	ob.enqueue(event('E1'))
	const ready = ob.claimReady(Date.now(), 10)
	assert.equal(ready.length, 1)
	assert.equal(ready[0].event_id, 'E1')
	assert.equal((ready[0].body as { chat_jid: string }).chat_jid, '1@g.us')
	assert.equal(ready[0].attempts, 0)
	ob.close()
})

test('markSent remove; reschedule adia para o futuro', () => {
	const ob = createOutbox(':memory:')
	ob.enqueue(event('E1'))
	ob.enqueue(event('E2'))
	ob.markSent('E1')
	assert.equal(ob.count(), 1)
	ob.reschedule('E2', 1, Date.now() + 60_000)
	assert.equal(ob.claimReady(Date.now(), 10).length, 0) // agendado pro futuro
	assert.equal(ob.claimReady(Date.now() + 61_000, 10).length, 1)
	ob.close()
})

test('deadLetter move pro outbox_dead: sai da fila ativa, preservado no dead', () => {
	const ob = createOutbox(':memory:')
	ob.enqueue(event('E1'))
	ob.deadLetter('E1', 422)
	assert.equal(ob.count(), 0)
	assert.equal(ob.deadCount(), 1)
	assert.equal(ob.claimReady(Date.now(), 10).length, 0) // não reaparece no loop ativo
	ob.close()
})

test('oldestPendingCreatedAt reflete o item mais antigo; null quando vazio', () => {
	const ob = createOutbox(':memory:')
	assert.equal(ob.oldestPendingCreatedAt(), null)
	ob.enqueue(event('E1'))
	const oldest = ob.oldestPendingCreatedAt()
	assert.ok(typeof oldest === 'number' && oldest > 0)
	ob.close()
})

test('pruneDead remove dead-letters antigos por dead_at', () => {
	const ob = createOutbox(':memory:')
	ob.enqueue(event('E1'))
	ob.deadLetter('E1', 400)
	assert.equal(ob.deadCount(), 1)
	ob.pruneDead(Date.now() - 1000) // cutoff no passado → nada removido (dead_at é "agora")
	assert.equal(ob.deadCount(), 1)
	ob.pruneDead(Date.now() + 1000) // cutoff no futuro → remove
	assert.equal(ob.deadCount(), 0)
	ob.close()
})
