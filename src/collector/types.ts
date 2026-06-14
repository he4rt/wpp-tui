export interface WebhookBody {
	type: string
	chat_jid: string | null
	payload: unknown
}

// Item da fila/outbox: o envelope enviado ao backend (`body`) + a chave de idempotência
// determinística (`event_id`, UUIDv5). O event_id é PK do outbox → dedup na origem (ADR-0003).
export interface OutboxEvent {
	event_id: string
	body: WebhookBody
}
