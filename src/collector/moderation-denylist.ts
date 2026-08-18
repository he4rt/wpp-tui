// Denylist de moderação: o que separa "remoção" de "ban".
//
// Remover alguém do WhatsApp não impede que ele volte pelo link de convite cinco minutos depois —
// e a comunidade tem link público. A denylist persiste a decisão em disco para que o enforcer
// (denylist-enforcer.ts) possa desfazer a reentrada assim que ela acontecer.
//
// Índice duplo (@lid e telefone) porque nem sempre temos os dois: um pré-ban conhece só o número
// (a pessoa ainda não entrou, então não há @lid), e um ban por reply num grupo endereçado por PN
// pode não expor o telefone. O evento de entrada traz os dois, então qualquer um dos dois casa.
//
// Fica em logs/denylist.json — arquivo solto na raiz de logs/, como o group-metadata.json. A poda
// de retenção só desce em subdiretórios com nome de data (retention.ts), então não o toca.

import fs from 'fs'
import path from 'path'
import { normalizePhone } from './command-core.js'

export interface DenylistEntry {
	lid: string | null // null enquanto for pré-ban (número que ainda não entrou)
	phone: string | null // só dígitos
	reason: string | null
	by: string // quem baniu (@lid do admin)
	at: string // ISO
	community: string | null // JID da comunidade onde o ban vale
}

// Candidato a ser checado contra a lista — vem do evento de entrada em grupo.
export interface DenylistCandidate {
	lid?: string | null
	phone?: string | null
}

export interface ModerationDenylist {
	// upsert por identidade (lid, senão telefone): rebanir alguém atualiza motivo/autor/data,
	// e um ban com @lid conhecido completa o pré-ban que só tinha o telefone.
	add(entry: DenylistEntry): DenylistEntry
	// remove quem casar; devolve a entrada removida (null se não estava na lista).
	remove(candidate: DenylistCandidate): DenylistEntry | null
	// consulta pura — não altera nada.
	match(candidate: DenylistCandidate): DenylistEntry | null
	list(): DenylistEntry[]
}

const DEFAULT_PATH = path.resolve('logs', 'denylist.json')

function load(file: string): DenylistEntry[] {
	if (!fs.existsSync(file)) return []
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
		return Array.isArray(parsed?.entries) ? parsed.entries : []
	} catch {
		// arquivo corrompido não pode derrubar a moderação: começa vazio e o próximo save conserta.
		return []
	}
}

function save(file: string, entries: DenylistEntry[]) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	// escrita atômica: um crash no meio do write deixaria a lista truncada, e uma denylist
	// truncada é pior que uma desatualizada — quem foi banido voltaria a passar.
	const tmp = `${file}.tmp`
	fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2))
	fs.renameSync(tmp, file)
}

const sameIdentity = (e: DenylistEntry, c: DenylistCandidate): boolean => {
	if (e.lid && c.lid && e.lid === c.lid) return true
	const phone = normalizePhone(c.phone)
	return Boolean(e.phone && phone && e.phone === phone)
}

export function createDenylist(deps: { path?: string } = {}): ModerationDenylist {
	const file = deps.path ?? DEFAULT_PATH
	const entries = load(file)

	return {
		list: () => entries.map((e) => ({ ...e })),

		match(candidate) {
			return entries.find((e) => sameIdentity(e, candidate)) ?? null
		},

		add(entry) {
			const normalized: DenylistEntry = { ...entry, phone: normalizePhone(entry.phone) }
			const existing = entries.findIndex((e) => sameIdentity(e, normalized))
			if (existing >= 0) {
				// preserva o que já se sabia: o novo ban não pode APAGAR o lid ou o telefone antigo.
				const merged = {
					...normalized,
					lid: normalized.lid ?? entries[existing].lid,
					phone: normalized.phone ?? entries[existing].phone,
				}
				entries[existing] = merged
				save(file, entries)
				return { ...merged }
			}
			entries.push(normalized)
			save(file, entries)
			return { ...normalized }
		},

		remove(candidate) {
			const idx = entries.findIndex((e) => sameIdentity(e, candidate))
			if (idx < 0) return null
			const [removed] = entries.splice(idx, 1)
			save(file, entries)
			return removed
		},
	}
}
