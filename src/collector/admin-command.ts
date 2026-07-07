// Comando de moderação /admin on|off: liga/desliga o modo "somente admins falam" do grupo.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// Escopo: só o grupo onde o comando foi digitado (sem cascata pra comunidade).
// A casca (loop best-effort, guarda de grupo/notify, audit, autorização) vem de command-handler.

import { messageText, parseCommand, type CmdParticipant } from './command-core.js'
import { createCommandHandler, requireGroupAdmin, type CommandContext, type CommandLogger } from './command-handler.js'

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

// Domínio do /admin: resolve on/off (entrada) → autoriza → idempotência → troca o setting. A ordem
// entrada→auth é preservada porque requireGroupAdmin é chamado só depois de validar o argumento.
const adminDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<AdminSocket>): Promise<void> => {
	const action = parseAdminAction(messageText(msg))
	// o audit do admin carrega `action` em todo log (como antes): embrulha o audit base uma vez.
	const auditAdmin: typeof audit = (result, extra = {}) => audit(result, { action, ...extra })

	if (!action) { auditAdmin('no_action'); return } // /admin sem on|off válido
	const meta = await requireGroupAdmin<AdminGroupMetadata>({ sock, groupJid, actor, audit: auditAdmin })
	if (!meta) return // já auditou not_admin / metadata_error

	// idempotência: se o grupo já está no estado alvo, não chama a API
	const wantAnnounce = action === 'on'
	if (Boolean(meta.announce) === wantAnnounce) {
		auditAdmin(wantAnnounce ? 'already_on' : 'already_off'); return
	}

	// aplica o setting no grupo
	try {
		await sock.groupSettingUpdate(groupJid, wantAnnounce ? 'announcement' : 'not_announcement')
		auditAdmin('applied')
	} catch (err) {
		auditAdmin('setting_error', { err: String(err) })
	}
}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createAdminHandler = (deps: { sock: AdminSocket; logger: CommandLogger }) =>
	createCommandHandler({ name: 'admin', sock: deps.sock, logger: deps.logger, domain: adminDomain })
