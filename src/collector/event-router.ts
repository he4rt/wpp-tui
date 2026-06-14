import { extractEvents } from './extractors.js'
import { isGroupJid } from './helpers.js'
import type { OutboxEvent } from './types.js'

export const DENYLIST = new Set<string>([
	'creds.update',
	'messaging-history.set',
	'chats.set',
	'contacts.set',
	'blocklist.set',
	// recibos de entrega/leitura: 1 evento por destinatário, infla muito a tabela e sem valor de coleta
	'message-receipt.update',
	// presença (digitando/online): firehose de altíssimo volume e baixo sinal — cortado nesta fase
	'presence.update',
])

export interface EventRouter {
	handleEvent(eventName: string, data: unknown): void
}

export function createEventRouter(outbox: { enqueue(event: OutboxEvent): void }): EventRouter {
	return {
		handleEvent(eventName, data) {
			if (DENYLIST.has(eventName)) return
			for (const event of extractEvents(eventName, data)) {
				if (!isGroupJid(event.body.chat_jid)) continue
				outbox.enqueue(event)
			}
		},
	}
}
