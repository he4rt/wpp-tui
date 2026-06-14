import { createHmac } from 'node:crypto'
import type { Outbox } from './outbox.js'

// HMAC cobre o event_id + o corpo cru: a chave de idempotência fica à prova de adulteração (ADR-0003).
// Formato do material assinado: `${eventId}.${rawBody}` — deve casar com o middleware do backend.
export function signPayload(eventId: string, rawBody: string, secret: string): string {
	return createHmac('sha256', secret).update(`${eventId}.${rawBody}`).digest('hex')
}

export function computeBackoffMs(attempts: number): number {
	return Math.min(1000 * 2 ** attempts, 5 * 60 * 1000)
}

// Classificação da resposta HTTP (ADR-0003 §4):
//   sent  → 2xx: persistido, apaga do outbox.
//   dead  → 400/422: rejeição permanente (payload/contrato) → dead-letter local + alerta.
//   auth  → 401/403: misconfig recuperável (segredo dessincronizado) → mantém na fila + alerta.
//   retry → 5xx / 408 / 429 / rede / timeout / demais → reagenda com backoff.
export type SendOutcome = 'sent' | 'retry' | 'auth' | 'dead'

export interface SendResult {
	outcome: SendOutcome
	status: number | null
}

export function classifyStatus(status: number): SendOutcome {
	if (status >= 200 && status < 300) return 'sent'
	if (status === 401 || status === 403) return 'auth'
	if (status === 400 || status === 422) return 'dead'
	return 'retry'
}

export type AlertKind = 'auth' | 'dead-letter' | 'overflow'

export interface SenderOptions {
	url: string
	secret: string
	fetchFn?: typeof fetch
	timeoutMs?: number
	onAlert?: (kind: AlertKind, detail: Record<string, unknown>) => void
}

export async function sendOnce(item: { event_id: string; body: unknown }, opts: SenderOptions): Promise<SendResult> {
	const raw = JSON.stringify(item.body)
	const f = opts.fetchFn ?? fetch
	const timeoutMs = opts.timeoutMs ?? 15_000
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	try {
		const res = await f(opts.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Signature': signPayload(item.event_id, raw, opts.secret),
				'X-Event-Id': item.event_id,
			},
			body: raw,
			signal: ac.signal,
		})
		return { outcome: classifyStatus(res.status), status: res.status }
	} catch {
		// rede caiu / abortado por timeout → transitório, reagenda
		return { outcome: 'retry', status: null }
	} finally {
		clearTimeout(timer)
	}
}

export function startWebhookSender(
	outbox: Outbox,
	opts: SenderOptions & {
		intervalMs?: number
		batch?: number
		overflowThreshold?: number
		deadRetentionMs?: number
		pruneIntervalMs?: number
	},
): () => void {
	let stopped = false
	let consecutiveAuthFailures = 0
	let lastPruneAt = 0
	const interval = opts.intervalMs ?? 1000
	const batch = opts.batch ?? 20
	const overflowThreshold = opts.overflowThreshold ?? 10_000
	const deadRetentionMs = opts.deadRetentionMs ?? 30 * 24 * 60 * 60 * 1000 // 30 dias
	const pruneIntervalMs = opts.pruneIntervalMs ?? 60 * 60 * 1000 // 1x/hora

	async function tick() {
		if (stopped) return

		// poda por idade APENAS do dead-letter (itens já alertados e fora do loop ativo).
		// A fila ATIVA nunca é auto-descartada — a resistência a falhas depende disso (ADR-0003).
		const now = Date.now()
		if (now - lastPruneAt >= pruneIntervalMs) {
			lastPruneAt = now
			outbox.pruneDead(now - deadRetentionMs)
		}

		const pending = outbox.count()
		if (pending >= overflowThreshold) {
			opts.onAlert?.('overflow', { pending, threshold: overflowThreshold })
		}

		const ready = outbox.claimReady(now, batch)
		for (const row of ready) {
			if (stopped) return
			const { outcome, status } = await sendOnce({ event_id: row.event_id, body: row.body }, opts)

			if (outcome === 'sent') {
				outbox.markSent(row.event_id)
				consecutiveAuthFailures = 0
			} else if (outcome === 'dead') {
				outbox.deadLetter(row.event_id, status ?? 0)
				opts.onAlert?.('dead-letter', { event_id: row.event_id, type: row.type, status })
			} else if (outcome === 'auth') {
				consecutiveAuthFailures += 1
				const attempts = row.attempts + 1
				outbox.reschedule(row.event_id, attempts, Date.now() + computeBackoffMs(attempts))
				// fail-loud: o segredo provavelmente está dessincronizado entre bot e backend.
				opts.onAlert?.('auth', { event_id: row.event_id, status, consecutiveAuthFailures })
			} else {
				const attempts = row.attempts + 1
				outbox.reschedule(row.event_id, attempts, Date.now() + computeBackoffMs(attempts))
			}
		}
	}

	const timer = setInterval(() => { void tick() }, interval)
	timer.unref?.()
	return () => {
		stopped = true
		clearInterval(timer)
	}
}
