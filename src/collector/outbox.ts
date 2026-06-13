import Database from 'better-sqlite3'
import type { OutboxEvent } from './types.js'

export interface OutboxRow {
	event_id: string
	type: string
	body: unknown
	attempts: number
}

export interface Outbox {
	enqueue(event: OutboxEvent): void
	claimReady(now: number, limit: number): OutboxRow[]
	markSent(eventId: string): void
	reschedule(eventId: string, attempts: number, nextAttempt: number): void
	deadLetter(eventId: string, status: number): void
	count(): number
	deadCount(): number
	oldestPendingCreatedAt(): number | null
	pruneDead(cutoff: number): number
	close(): void
}

export function createOutbox(dbPath: string): Outbox {
	const db = new Database(dbPath)
	db.pragma('journal_mode = WAL')
	db.exec(`
		CREATE TABLE IF NOT EXISTS outbox (
			event_id     TEXT PRIMARY KEY,
			type         TEXT NOT NULL,
			body         TEXT NOT NULL,
			attempts     INTEGER NOT NULL DEFAULT 0,
			next_attempt INTEGER NOT NULL,
			created_at   INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS outbox_dead (
			event_id   TEXT PRIMARY KEY,
			type       TEXT NOT NULL,
			body       TEXT NOT NULL,
			attempts   INTEGER NOT NULL,
			status     INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			dead_at    INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_outbox_dead_dead_at ON outbox_dead (dead_at);
	`)
	// INSERT OR IGNORE: com o event_id determinístico como PK, um re-emit idêntico é ignorado
	// silenciosamente AQUI (dedup na origem — ADR-0003). Nada vai à rede.
	const insert = db.prepare(
		`INSERT OR IGNORE INTO outbox (event_id, type, body, attempts, next_attempt, created_at) VALUES (?, ?, ?, 0, ?, ?)`,
	)
	const selectReady = db.prepare(
		`SELECT event_id, type, body, attempts FROM outbox WHERE next_attempt <= ? ORDER BY created_at LIMIT ?`,
	)
	const selectOne = db.prepare(`SELECT event_id, type, body, attempts, created_at FROM outbox WHERE event_id = ?`)
	const del = db.prepare(`DELETE FROM outbox WHERE event_id = ?`)
	const upd = db.prepare(`UPDATE outbox SET attempts = ?, next_attempt = ? WHERE event_id = ?`)
	const cnt = db.prepare(`SELECT COUNT(*) AS n FROM outbox`)
	const oldest = db.prepare(`SELECT MIN(created_at) AS m FROM outbox`)
	const insertDead = db.prepare(
		`INSERT OR IGNORE INTO outbox_dead (event_id, type, body, attempts, status, created_at, dead_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	const cntDead = db.prepare(`SELECT COUNT(*) AS n FROM outbox_dead`)
	const delDead = db.prepare(`DELETE FROM outbox_dead WHERE dead_at < ?`)

	// move um item do outbox ativo para o dead-letter de forma atômica (preservado, fora do loop ativo).
	const toDead = db.transaction((eventId: string, status: number, now: number) => {
		const row = selectOne.get(eventId) as Record<string, any> | undefined
		if (!row) return
		insertDead.run(row.event_id, row.type, row.body, row.attempts, status, row.created_at, now)
		del.run(eventId)
	})

	return {
		enqueue(event) {
			const now = Date.now()
			insert.run(event.event_id, event.body.type, JSON.stringify(event.body), now, now)
		},
		claimReady(now, limit) {
			const rows = selectReady.all(now, limit) as Array<Record<string, any>>
			return rows.map((r) => ({ event_id: r.event_id, type: r.type, body: JSON.parse(r.body), attempts: r.attempts }))
		},
		markSent(eventId) {
			del.run(eventId)
		},
		reschedule(eventId, attempts, nextAttempt) {
			upd.run(attempts, nextAttempt, eventId)
		},
		deadLetter(eventId, status) {
			toDead(eventId, status, Date.now())
		},
		count() {
			return (cnt.get() as { n: number }).n
		},
		deadCount() {
			return (cntDead.get() as { n: number }).n
		},
		oldestPendingCreatedAt() {
			const m = (oldest.get() as { m: number | null }).m
			return m ?? null
		},
		pruneDead(cutoff) {
			return delDead.run(cutoff).changes
		},
		close() {
			db.close()
		},
	}
}
