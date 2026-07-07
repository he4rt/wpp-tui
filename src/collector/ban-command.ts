// Comando de moderação /ban: parse do comando, resolução do alvo e execução da remoção.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// A casca (loop best-effort, guarda de grupo/notify, audit, autorização) vem de command-handler.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage } from './command-core.js'
import { createCommandHandler, requireGroupAdmin, type CommandContext, type CommandLogger } from './command-handler.js'

// Compat: BanMessage é o shape genérico de mensagem compartilhado (command-core).
export type BanMessage = CmdMessage
export { messageText }

// Detecta o comando /ban — aceita "/ban" e "!ban" (case-insensitive) pelo primeiro token.
export function parseBanCommand(text: string): boolean {
	return parseCommand(text)?.name === 'ban'
}

// Alvo do ban: reply (autor da msg citada) tem prioridade; senão, o primeiro mencionado.
// Reply é detectado por stanzaId + participant juntos (evita falsos positivos de contextInfo).
export function resolveBanTarget(msg: BanMessage): string | null {
	const ctx = msg.message?.extendedTextMessage?.contextInfo
	if (!ctx) return null
	if (ctx.stanzaId && ctx.participant) return ctx.participant
	const mentioned = ctx.mentionedJid
	if (mentioned && mentioned.length > 0) return mentioned[0]
	return null
}

// ---- handler ----

export interface BanParticipant {
	id: string
	admin?: 'admin' | 'superadmin' | null
}
export interface BanGroupMetadata {
	id: string
	owner?: string | null
	linkedParent?: string | null // JID da comunidade pai, se o grupo for subgrupo de uma comunidade
	participants: BanParticipant[]
}
export interface BanUpdateResult {
	status: string
	jid?: string
}
// Interface mínima do socket do Baileys que o handler precisa (injetável p/ testes sem rede).
export interface BanSocket {
	groupMetadata(jid: string): Promise<BanGroupMetadata>
	groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
	communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
}

// Domínio do /ban: resolve o alvo (entrada) → autoriza → guardrails → remoção. A ordem entrada→auth
// é preservada porque requireGroupAdmin é chamado só depois de resolver/validar o alvo.
const banDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<BanSocket>): Promise<void> => {
	const targetRaw = resolveBanTarget(msg)
	// o audit do ban carrega `target` em todo log (como antes): embrulha o audit base uma vez.
	const auditBan: typeof audit = (result, extra = {}) => audit(result, { target: targetRaw, ...extra })

	if (!targetRaw) { auditBan('no_target'); return }
	const meta = await requireGroupAdmin<BanGroupMetadata>({ sock, groupJid, actor, audit: auditBan })
	if (!meta) return // já auditou not_admin / metadata_error

	const target = jidNormalizedUser(targetRaw)
	const participants = meta.participants || []
	const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

	// guardrails
	if (target === actor) { auditBan('self_ban'); return }
	const targetP = findP(target)
	if (!targetP) { auditBan('target_not_member'); return }
	if (isAdmin(targetP)) { auditBan('target_is_admin'); return }
	if (meta.owner && jidNormalizedUser(meta.owner) === target) { auditBan('target_is_owner'); return }

	// remoção
	try {
		let res: BanUpdateResult[]
		if (meta.linkedParent) {
			// proteção extra: o dono da COMUNIDADE pode diferir do owner do subgrupo
			try {
				const parent = await sock.groupMetadata(meta.linkedParent)
				if (parent.owner && jidNormalizedUser(parent.owner) === target) { auditBan('target_is_owner'); return }
			} catch { /* sem a metadata do pai, segue sem essa checagem extra */ }
			// communityParticipantsUpdate com 'remove' manda linked_groups:true → sai da comunidade + subgrupos
			res = await sock.communityParticipantsUpdate(meta.linkedParent, [targetP.id], 'remove')
		} else {
			res = await sock.groupParticipantsUpdate(groupJid, [targetP.id], 'remove')
		}
		auditBan('removed', { status: res?.[0]?.status ?? 'unknown', community: meta.linkedParent ?? null })
	} catch (err) {
		auditBan('remove_error', { err: String(err) })
	}
}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createBanHandler = (deps: { sock: BanSocket; logger: CommandLogger }) =>
	createCommandHandler({ name: 'ban', sock: deps.sock, logger: deps.logger, domain: banDomain })
