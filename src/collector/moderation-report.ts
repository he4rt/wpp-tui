// Relatório de moderação: transforma uma linha de auditoria em algo que um humano lê no WhatsApp.
//
// Até aqui o resultado de um comando existia só no journal do servidor — o moderador digitava
// /ban e não tinha como saber se funcionou, se foi recusado por permissão ou se o alvo nem existia.
// Toda tentativa (inclusive as negadas) vira uma mensagem no grupo de log, e o mesmo conteúdo
// continua indo para o journal, onde o operador o encontra quando o WhatsApp estiver fora do ar.
//
// O bot segue silencioso onde importa: nada é enviado a grupo comum, só ao grupo de log.

export interface ReportEntry {
	command: string // 'ban' | 'kick' | 'unban' | 'admin' | 'denylist'
	result: string // 'removed', 'not_authorized', 'remove_rejected'…
	group: string // JID do grupo onde o comando foi digitado
	actor: string // @lid de quem comandou
	actorName?: string | null // pushName, quando a mensagem trouxe
	deleted?: boolean // o comando foi apagado do grupo?
	fields: Record<string, unknown> // o resto do audit (target, phone, status, reason…)
}

export interface ReportSocket {
	sendMessage(jid: string, content: { text: string }): Promise<unknown>
}

// Resultados agrupados por natureza — o ícone é o que o moderador lê primeiro na lista.
const ICON: Record<string, string> = {
	removed: '🔨',
	pre_banned: '🪤',
	unbanned: '🔓',
	enforced: '🔁',
	applied: '⚙️',
}
const REJECTED = new Set([
	'not_authorized',
	'self_ban',
	'target_is_admin',
	'target_is_community_admin',
	'target_is_owner',
	'target_not_member',
	'target_not_in_group',
])
const FAILED = new Set(['remove_rejected', 'enforce_rejected', 'remove_error', 'enforce_error', 'setting_error', 'directory_error', 'handler_error'])

function iconFor(result: string): string {
	if (ICON[result]) return ICON[result]
	if (REJECTED.has(result)) return '🚫'
	if (FAILED.has(result)) return '⚠️'
	return 'ℹ️' // no_target, target_not_found, not_in_denylist, already_on/off, duplicate_ignored…
}

// "5500900000001" → "+55 00 90000-0001" quando dá; senão devolve como está.
export function prettyPhone(phone: unknown): string | null {
	if (typeof phone !== 'string' || !phone) return null
	const m = /^(\d{2})(\d{2})(\d{4,5})(\d{4})$/.exec(phone)
	return m ? `+${m[1]} ${m[2]} ${m[3]}-${m[4]}` : `+${phone}`
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Monta o texto do relatório. Puro — o teste cobre a formatação sem socket.
// `groupName` traduz JID → nome; devolve o próprio JID quando não conhece.
export function formatReport(entry: ReportEntry, groupName: (jid: string) => string): string {
	const f = entry.fields
	const lines: string[] = [`${iconFor(entry.result)} /${entry.command} · ${entry.result}`]

	lines.push(`grupo: ${groupName(entry.group)}`)
	lines.push(`por: ${entry.actorName ? `${entry.actorName} · ` : ''}${entry.actor || '?'}`)

	const target = asString(f.target)
	const phone = prettyPhone(f.phone)
	if (target || phone) {
		lines.push(`alvo: ${[phone, target].filter(Boolean).join(' · ')}`)
	}

	const via = asString(f.via)
	if (via) lines.push(`identificado por: ${via}`)

	const removedFrom = asList(f.removedFrom)
	if (removedFrom.length) lines.push(`saiu de: ${removedFrom.map(groupName).join(', ')}`)

	const community = asString(f.community)
	if (community && f.reach === 'community') lines.push(`alcance: comunidade ${groupName(community)}`)
	if (f.reach === 'group') lines.push('alcance: só este grupo')

	const reason = asString(f.reason)
	if (reason) lines.push(`motivo: ${reason}`)

	// contexto do /unban: o que está sendo desfeito
	const bannedBy = asString(f.bannedBy)
	if (bannedBy) lines.push(`ban original: ${bannedBy} em ${asString(f.bannedAt) ?? '?'}${f.bannedReason ? ` — ${f.bannedReason}` : ''}`)

	const status = asString(f.status)
	if (status && status !== '200') lines.push(`resposta do WhatsApp: ${status}${status === '403' ? ' (o bot não é admin da comunidade)' : ''}`)

	const addedBy = asString(f.addedBy)
	if (addedBy) lines.push(`adicionado por: ${addedBy}`)

	if (f.denylisted) lines.push('denylist: registrado')
	if (entry.deleted) lines.push('comando apagado ✓')

	return lines.join('\n')
}

export interface ModerationReporter {
	publish(entry: ReportEntry): Promise<void>
}

// Publica no grupo de log. Sem LOG_GROUP_JID configurado vira no-op — o journal segue completo.
export function createModerationReporter(deps: {
	sock: ReportSocket
	logGroupJid: string | null
	groupName?: (jid: string) => string
	onError?: (err: unknown) => void
}): ModerationReporter {
	const { sock, logGroupJid } = deps
	const groupName = deps.groupName ?? ((jid: string) => jid)

	return {
		async publish(entry) {
			if (!logGroupJid) return
			try {
				await sock.sendMessage(logGroupJid, { text: formatReport(entry, groupName) })
			} catch (err) {
				// falha ao publicar não pode derrubar o comando nem a coleta: o journal já registrou.
				deps.onError?.(err)
			}
		},
	}
}
