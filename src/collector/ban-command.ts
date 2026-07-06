// Comando de moderação /ban: parse do comando, resolução do alvo e execução da remoção.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage } from './command-core.js'

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
export interface BanLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}
export interface BanUpsert {
	type: string
	messages: BanMessage[]
}

export function createBanHandler(deps: { sock: BanSocket; logger: BanLogger }) {
	const { sock, logger } = deps

	async function handleMessage(msg: BanMessage): Promise<void> {
		const groupJid = msg.key?.remoteJid
		if (!groupJid || !groupJid.endsWith('@g.us')) return // só grupos
		if (!parseBanCommand(messageText(msg))) return // só o comando /ban

		const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
		const targetRaw = resolveBanTarget(msg)
		const audit = (result: string, extra: Record<string, unknown> = {}) =>
			logger.info({ actor, target: targetRaw, group: groupJid, result, ...extra }, 'ban: tentativa')

		if (!targetRaw) { audit('no_target'); return }
		const target = jidNormalizedUser(targetRaw)

		let meta: BanGroupMetadata
		try {
			meta = await sock.groupMetadata(groupJid)
		} catch (err) {
			audit('metadata_error', { err: String(err) }); return
		}

		const participants = meta.participants || []
		const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

		// autorização: quem mandou precisa ser admin/superadmin do grupo
		if (!isAdmin(findP(actor))) { audit('not_admin'); return }

		// guardrails
		if (target === actor) { audit('self_ban'); return }
		const targetP = findP(target)
		if (!targetP) { audit('target_not_member'); return }
		if (isAdmin(targetP)) { audit('target_is_admin'); return }
		if (meta.owner && jidNormalizedUser(meta.owner) === target) { audit('target_is_owner'); return }

		// remoção
		try {
			let res: BanUpdateResult[]
			if (meta.linkedParent) {
				// proteção extra: o dono da COMUNIDADE pode diferir do owner do subgrupo
				try {
					const parent = await sock.groupMetadata(meta.linkedParent)
					if (parent.owner && jidNormalizedUser(parent.owner) === target) { audit('target_is_owner'); return }
				} catch { /* sem a metadata do pai, segue sem essa checagem extra */ }
				// communityParticipantsUpdate com 'remove' manda linked_groups:true → sai da comunidade + subgrupos
				res = await sock.communityParticipantsUpdate(meta.linkedParent, [targetP.id], 'remove')
			} else {
				res = await sock.groupParticipantsUpdate(groupJid, [targetP.id], 'remove')
			}
			audit('removed', { status: res?.[0]?.status ?? 'unknown', community: meta.linkedParent ?? null })
		} catch (err) {
			audit('remove_error', { err: String(err) })
		}
	}

	return {
		// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
		async handle(upsert: BanUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					await handleMessage(msg)
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, 'ban: erro inesperado')
				}
			}
		},
	}
}
