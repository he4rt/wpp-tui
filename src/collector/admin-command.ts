// Comando de moderação /admin on|off: liga/desliga o modo "somente admins falam" do grupo.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// Escopo: só o grupo onde o comando foi digitado (sem cascata pra comunidade).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdParticipant, type CmdUpsert } from './command-core.js'

// 'on' | 'off' se for o comando /admin (ou !admin) com argumento válido; senão null.
export function parseAdminAction(text: string): 'on' | 'off' | null {
	const cmd = parseCommand(text)
	if (cmd?.name !== 'admin') return null
	const arg = cmd.args[0]
	return arg === 'on' || arg === 'off' ? arg : null
}

// Shape mínimo da metadata que o handler precisa (announce p/ idempotência + participants p/ auth).
export interface AdminGroupMetadata {
	id: string
	announce?: boolean | null
	participants: CmdParticipant[]
}
// Interface mínima do socket do Baileys que o handler precisa (injetável p/ testes sem rede).
export interface AdminSocket {
	groupMetadata(jid: string): Promise<AdminGroupMetadata>
	groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement'): Promise<void>
}
export interface AdminLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}

export function createAdminHandler(deps: { sock: AdminSocket; logger: AdminLogger }) {
	const { sock, logger } = deps

	async function handleMessage(msg: CmdMessage): Promise<void> {
		const groupJid = msg.key?.remoteJid
		if (!groupJid || !groupJid.endsWith('@g.us')) return // só grupos

		const text = messageText(msg)
		if (parseCommand(text)?.name !== 'admin') return // só o comando /admin (aceita ! e /)

		const action = parseAdminAction(text)
		const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
		const audit = (result: string, extra: Record<string, unknown> = {}) =>
			logger.info({ actor, group: groupJid, action, result, ...extra }, 'admin: tentativa')

		if (!action) { audit('no_action'); return } // /admin sem on|off válido

		let meta: AdminGroupMetadata
		try {
			meta = await sock.groupMetadata(groupJid)
		} catch (err) {
			audit('metadata_error', { err: String(err) }); return
		}

		const participants = meta.participants || []
		const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

		// autorização: quem mandou precisa ser admin/superadmin do grupo
		if (!isAdmin(findP(actor))) { audit('not_admin'); return }

		// idempotência: se o grupo já está no estado alvo, não chama a API
		const wantAnnounce = action === 'on'
		if (Boolean(meta.announce) === wantAnnounce) {
			audit(wantAnnounce ? 'already_on' : 'already_off'); return
		}

		// aplica o setting no grupo
		try {
			await sock.groupSettingUpdate(groupJid, wantAnnounce ? 'announcement' : 'not_announcement')
			audit('applied')
		} catch (err) {
			audit('setting_error', { err: String(err) })
		}
	}

	return {
		// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
		async handle(upsert: CmdUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					await handleMessage(msg)
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, 'admin: erro inesperado')
				}
			}
		},
	}
}
