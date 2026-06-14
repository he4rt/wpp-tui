import { canonicalHash, eventId } from './helpers.js'
import type { OutboxEvent } from './types.js'

// O coletor é quase "burro": cada evento Baileys vira um envelope { type, chat_jid, payload }
// com o payload CRU. A única leitura estrutural é (a) o JID do chat (filtro de grupos + indexação)
// e (b) a chave de idempotência determinística (event_id, UUIDv5) — ver ADR-0003. Nada de conteúdo
// de mensagem é interpretado/transformado aqui.
type Extractor = (data: unknown) => OutboxEvent[]

const messagesUpsert: Extractor = (data) => {
	const d = data as { messages?: Array<Record<string, any>> }
	return (d.messages ?? []).map((msg) => {
		const remoteJid = (msg.key?.remoteJid as string) ?? null
		// chave = (type, remoteJid, key.id): `notify` e `append` da MESMA msg colapsam → backfill idempotente.
		return {
			event_id: eventId('messages.upsert', remoteJid, msg.key?.id as string | undefined),
			body: { type: 'messages.upsert', chat_jid: remoteJid, payload: msg },
		}
	})
}

// messages.reaction: `data` já é o array de reações; 1 envelope por reação.
const messagesReaction: Extractor = (data) => {
	const arr = (Array.isArray(data) ? data : []) as Array<Record<string, any>>
	return arr.map((r) => {
		const chatJid = (r.key?.remoteJid as string) ?? null
		const targetId = r.key?.id as string | undefined
		const reactor = (r.reaction?.key?.participant as string) ?? (r.key?.participant as string) ?? null
		const text = (r.reaction?.text as string) ?? ''
		// chave = (type, target msg id, reactor, emoji): re-emit colapsa; troca/remoção de emoji = linha nova.
		// senderTimestampMs FICA DE FORA (instável entre re-emissões — ADR-0003).
		return {
			event_id: eventId('messages.reaction', targetId, reactor, text),
			body: { type: 'messages.reaction', chat_jid: chatJid, payload: r },
		}
	})
}

// group-participants.update: objeto único de um chat — encaminhado CRU (a lista vive no payload).
const groupParticipantsUpdate: Extractor = (data) => {
	const d = (data ?? {}) as { id?: string }
	const jid = (d.id as string) ?? null
	return [{
		event_id: eventId('group-participants.update', jid, canonicalHash(d)),
		body: { type: 'group-participants.update', chat_jid: jid, payload: d },
	}]
}

// Snapshot completo da metadata do grupo (buscado via sock.groupMetadata() na conexão).
// Encaminhado CRU; o backend guarda sem processar membership. A chave é o hash CANÔNICO do
// snapshot → reconexões com o mesmo roster colapsam; mudança real de roster = snapshot novo.
const groupsMetadata: Extractor = (data) => {
	const meta = (data ?? {}) as Record<string, any>
	const jid = (meta.id as string) ?? null
	return [{
		event_id: eventId('groups.metadata', jid, canonicalHash(meta)),
		body: { type: 'groups.metadata', chat_jid: jid, payload: meta },
	}]
}

// Fallback genérico: array ou objeto único; melhor esforço para achar o JID do chat.
// `groupId` cobre eventos como group.member-tag.update, cujo JID NÃO está em `id`/`key.remoteJid`
// (antes caíam fora do filtro de grupo e eram descartados em silêncio — ADR-0003).
function genericExtractor(eventName: string): Extractor {
	return (data) => {
		const items = (Array.isArray(data) ? data : [data]) as Array<Record<string, any>>
		return items.map((it) => {
			const jid = (it?.id as string) ?? (it?.groupId as string) ?? (it?.key?.remoteJid as string) ?? null
			return {
				event_id: eventId(eventName, jid, canonicalHash(it)),
				body: { type: eventName, chat_jid: jid, payload: it },
			}
		})
	}
}

const registry: Record<string, Extractor> = {
	'messages.upsert': messagesUpsert,
	'messages.reaction': messagesReaction,
	'group-participants.update': groupParticipantsUpdate,
	'groups.metadata': groupsMetadata,
}

export function extractEvents(eventName: string, data: unknown): OutboxEvent[] {
	const fn = registry[eventName] ?? genericExtractor(eventName)
	return fn(data)
}
