import { createHash } from 'node:crypto'

export function isGroupJid(jid: string | null | undefined): boolean {
	return typeof jid === 'string' && jid.endsWith('@g.us')
}

// Namespace fixo (UUID) para derivar event_ids determinísticos (UUIDv5) do coletor WhatsApp.
// NÃO mudar: mudar o namespace muda TODOS os event_ids e quebra a dedup contra linhas já no lake.
const WHATSAPP_EVENT_NAMESPACE = 'b5f8c1e2-3a4d-4f6b-9c7e-1d2a3b4c5d6e'

// UUIDv5 (RFC 4122): SHA-1(namespace_bytes || name), com os bits de versão (5) e variante fixados.
// Node não traz uuidv5 nativo; implementado aqui sobre node:crypto.
function uuidv5(name: string, namespace: string): string {
	const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
	const hash = createHash('sha1').update(nsBytes).update(name, 'utf8').digest()
	const bytes = hash.subarray(0, 16)
	bytes[6] = (bytes[6] & 0x0f) | 0x50 // versão 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80 // variante RFC 4122
	const hex = bytes.toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Chave determinística por evento: mesmo conteúdo lógico → mesmo event_id.
// As partes nulas/undefined viram '' para manter a chave estável (vide ADR-0003).
export function eventId(...parts: Array<string | null | undefined>): string {
	return uuidv5(parts.map((p) => p ?? '').join('|'), WHATSAPP_EVENT_NAMESPACE)
}

// Representação canônica e estável de um valor: chaves de objeto ordenadas e arrays "set-like"
// (todo elemento tem `id`, ex.: participants) ordenados por id. Sem isso, cada reconexão
// reordena participants e o snapshot vira "novo" — derrotando a dedup por conteúdo (ADR-0003 §9).
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = value.map(canonicalize)
		const allHaveId = items.length > 0 && items.every((it) => it !== null && typeof it === 'object' && 'id' in (it as Record<string, unknown>))
		if (allHaveId) {
			return [...items].sort((a, b) => String((a as Record<string, unknown>).id).localeCompare(String((b as Record<string, unknown>).id)))
		}
		return items
	}
	if (value !== null && typeof value === 'object') {
		const obj = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(obj).sort()) {
			out[key] = canonicalize(obj[key])
		}
		return out
	}
	return value
}

// Hash estável do conteúdo canônico — base da chave de dedup "por conteúdo".
export function canonicalHash(value: unknown): string {
	return createHash('sha1').update(JSON.stringify(canonicalize(value))).digest('hex')
}
