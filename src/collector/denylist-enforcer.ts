// Enforcer da denylist: quem foi banido e volta é removido de novo, na hora.
//
// Sem isto o /ban é só uma remoção — a comunidade tem link de convite público, e voltar custa um
// clique. O gancho é o group-participants.update com action 'add', que o WhatsApp dispara tanto na
// entrada por link quanto quando um admin adiciona alguém à mão (os dois casos são cobertos).
//
// O evento traz id (@lid) e phoneNumber de cada participante, então casa com os dois índices da
// denylist — inclusive com um pré-ban, que só conhecia o número.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { normalizePhone } from './command-core.js'
import type { CommandLogger } from './command-handler.js'
import type { CommunityDirectory, DirectorySocket } from './community-directory.js'
import type { ModerationDenylist } from './moderation-denylist.js'

export interface EnforcerParticipant {
	id: string
	phoneNumber?: string | null
}
export interface ParticipantsUpdate {
	id: string // JID do grupo
	author?: string | null // quem adicionou (vazio quando entrou por link)
	action: string
	participants: EnforcerParticipant[]
}

export interface EnforcerSocket extends DirectorySocket {
	groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<{ status: string; jid?: string }[]>
	communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<{ status: string; jid?: string }[]>
}

// Janela de deduplicação: entrar numa comunidade dispara um 'add' por subgrupo (visto nos logs
// reais: mesma pessoa, mesmo instante, dois grupos). Sem isto, cada um viraria uma chamada de
// remoção idêntica. A remoção em si é idempotente — o problema é o ruído e o rate limit.
const DEDUPE_MS = 10_000

export function createDenylistEnforcer(deps: {
	sock: EnforcerSocket
	logger: CommandLogger
	denylist: ModerationDenylist
	directory: CommunityDirectory
	now?: () => number
}) {
	const { sock, logger, denylist, directory } = deps
	const now = deps.now ?? Date.now
	const recent = new Map<string, number>()

	const recentlyHandled = (key: string): boolean => {
		const at = recent.get(key)
		if (at !== undefined && now() - at < DEDUPE_MS) return true
		recent.set(key, now())
		// poda oportunista: a lista só cresce enquanto houver reentradas, mas não custa limpar.
		for (const [k, t] of recent) if (now() - t >= DEDUPE_MS) recent.delete(k)
		return false
	}

	return {
		// best-effort: nunca lança (não pode derrubar a coleta).
		async handle(update: ParticipantsUpdate): Promise<void> {
			try {
				if (update?.action !== 'add') return
				const groupJid = update.id
				if (!groupJid?.endsWith('@g.us')) return

				for (const p of update.participants || []) {
					const lid = p.id ? jidNormalizedUser(p.id) : null
					const phone = normalizePhone(p.phoneNumber)
					const entry = denylist.match({ lid, phone })
					if (!entry) continue

					const audit = (result: string, extra: Record<string, unknown> = {}) =>
						logger.info(
							{ target: lid, phone, group: groupJid, addedBy: update.author ?? null, reason: entry.reason, result, ...extra },
							'denylist: reentrada',
						)

					if (recentlyHandled(lid ?? phone ?? groupJid)) {
						audit('duplicate_ignored')
						continue
					}

					// pré-ban casado pelo telefone: agora sabemos o @lid — completa a entrada.
					if (lid && !entry.lid) denylist.add({ ...entry, lid, phone: entry.phone ?? phone })

					const view = await directory.viewFor(groupJid)
					const viaCommunity = view?.scope === 'community' && view.communityJid
					try {
						const res = viaCommunity
							? await sock.communityParticipantsUpdate(view.communityJid!, [p.id], 'remove')
							: await sock.groupParticipantsUpdate(groupJid, [p.id], 'remove')
						const status = res?.[0]?.status ?? 'unknown'
						audit(status === '200' ? 'enforced' : 'enforce_rejected', {
							status,
							reach: viaCommunity ? 'community' : 'group',
						})
					} catch (err) {
						audit('enforce_error', { err: String(err) })
					}
				}
			} catch (err) {
				logger.info({ result: 'handler_error', err: String(err) }, 'denylist: erro inesperado')
			}
		},
	}
}
