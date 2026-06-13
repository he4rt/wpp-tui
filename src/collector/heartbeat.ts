import type { Outbox } from './outbox.js'

// Snapshot de saúde do coletor para o heartbeat (ADR-0003 §10): status da conexão, profundidade
// do outbox ativo, tamanho do dead-letter e idade do item pendente mais antigo (detecta fila "presa").
export interface HeartbeatStats {
	status: string
	pending: number
	dead: number
	oldestAgeMs: number | null
}

type OutboxStats = Pick<Outbox, 'count' | 'deadCount' | 'oldestPendingCreatedAt'>

// Puro (now injetado) → testável sem timers.
export function collectHeartbeat(outbox: OutboxStats, status: string, now: number): HeartbeatStats {
	const oldest = outbox.oldestPendingCreatedAt()
	return {
		status,
		pending: outbox.count(),
		dead: outbox.deadCount(),
		oldestAgeMs: oldest === null ? null : Math.max(0, now - oldest),
	}
}

export function startHeartbeat(opts: {
	outbox: OutboxStats
	status: () => string
	log: (stats: HeartbeatStats) => void
	intervalMs?: number
}): () => void {
	const interval = opts.intervalMs ?? 60_000
	const timer = setInterval(() => {
		opts.log(collectHeartbeat(opts.outbox, opts.status(), Date.now()))
	}, interval)
	timer.unref?.()
	return () => clearInterval(timer)
}
