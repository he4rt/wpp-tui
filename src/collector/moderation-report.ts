// Relatório de moderação: transforma uma linha de auditoria em algo que um humano lê no WhatsApp.
//
// Até aqui o resultado de um comando existia só no journal do servidor — o moderador digitava
// /ban e não tinha como saber se funcionou, se foi recusado por permissão ou se o alvo nem existia.
// Toda tentativa (inclusive as negadas) vira uma mensagem no grupo de log, e o mesmo conteúdo
// continua indo para o journal, onde o operador o encontra quando o WhatsApp estiver fora do ar.
//
// O bot segue silencioso onde importa: nada é enviado a grupo comum, só ao grupo de log.

export interface ReportEntry {
	command: string // 'ban' | 'kick' | 'admin'
	result: string // 'removed', 'not_authorized', 'remove_rejected'…
	group: string // JID do grupo onde o comando foi digitado
	actor: string // @lid de quem comandou
	actorName?: string | null // pushName, quando a mensagem trouxe
	text?: string | null // o comando como foi digitado (já truncado pela casca)
	deleted?: boolean // o comando foi apagado do grupo?
	fields: Record<string, unknown> // o resto do audit (target, phone, status, reason…)
}

export interface ReportSocket {
	sendMessage(jid: string, content: { text: string }): Promise<unknown>
}

// Resultados agrupados por natureza — o ícone é o que o moderador lê primeiro na lista.
const ICON: Record<string, string> = {
	removed: '🔨',
	applied: '⚙️',
}
const REJECTED = new Set([
	'not_authorized',
	'not_admin', // mesma natureza do not_authorized: barrado por regra, não por falha
	'self_ban',
	'target_is_admin',
	'target_is_community_admin',
	'target_is_owner',
	'target_not_member',
	'target_not_in_group',
])
const FAILED = new Set(['remove_rejected', 'remove_error', 'setting_error', 'directory_error', 'metadata_error', 'delete_error', 'handler_error'])

function iconFor(result: string): string {
	if (ICON[result]) return ICON[result]
	if (REJECTED.has(result)) return '🚫'
	if (FAILED.has(result)) return '⚠️'
	return 'ℹ️' // no_target, target_not_found, phone_incomplete, already_on/off…
}

// "5500900000001" → "+55 00 90000-0001" quando dá; senão devolve como está.
export function prettyPhone(phone: unknown): string | null {
	if (typeof phone !== 'string' || !phone) return null
	const m = /^(\d{2})(\d{2})(\d{4,5})(\d{4})$/.exec(phone)
	return m ? `+${m[1]} ${m[2]} ${m[3]}-${m[4]}` : `+${phone}`
}

// Teto do erro no relatório: stack traces do Baileys chegam a milhares de caracteres, e a mensagem
// no WhatsApp precisa continuar legível. O log do servidor guarda o erro inteiro.
const MAX_ERR = 160

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Monta o texto do relatório. Puro — o teste cobre a formatação sem socket.
// `groupName` traduz JID → nome; devolve o próprio JID quando não conhece.
export function formatReport(entry: ReportEntry, groupName: (jid: string) => string): string {
	const f = entry.fields
	const lines: string[] = [`${iconFor(entry.result)} /${entry.command} · ${entry.result}`]

	lines.push(`grupo: ${groupName(entry.group)}`)
	lines.push(`por: ${entry.actorName ? `${entry.actorName} · ` : ''}${entry.actor || '?'}`)
	// o comando como foi digitado: é o que explica um no_target ou um alvo diferente do esperado —
	// e, como o bot apaga a mensagem do grupo, aqui é onde ela sobrevive de forma legível.
	if (entry.text) lines.push(`digitou: ${entry.text}`)

	const via = asString(f.via)
	// número parcial não é um telefone: formatá-lo como "+912345678" faz parecer que o alvo foi
	// identificado, quando o que houve foi uma busca que não fechou.
	const parcial = via === 'phone_incomplete' || via === 'phone_ambiguous'
	const target = asString(f.target)
	const phone = prettyPhone(f.phone)

	if (parcial) {
		if (asString(f.phone)) lines.push(`número digitado: ${asString(f.phone)}`)
	} else if (target || phone) {
		lines.push(`alvo: ${[phone, target].filter(Boolean).join(' · ')}`)
	}

	if (via) lines.push(`identificado por: ${via}`)

	// 2. quantos membros casaram com o final digitado — sem isso, "ambíguo" não diz o que fazer.
	if (typeof f.candidates === 'number') lines.push(`casou com ${f.candidates} membros — digite mais dígitos`)

	// 1. o log já separava admin de subgrupo de membro comum; o relatório escondia a diferença.
	if (f.groupAdmin === true) lines.push('quem tentou: admin deste grupo (a autoridade é da comunidade)')
	else if (f.member === false) lines.push('quem tentou: não está na lista de participantes do grupo')
	else if (f.member === true) lines.push('quem tentou: membro comum')

	// /admin: sem isto um "applied" não diz se o grupo foi fechado ou reaberto — e um "already_off"
	// parecia aplicação.
	const action = asString(f.action)
	if (action) {
		if (typeof f.announceBefore === 'boolean' && typeof f.announceAfter === 'boolean') {
			lines.push(`somente admins falam: ${f.announceBefore ? 'on' : 'off'} → ${f.announceAfter ? 'on' : 'off'}`)
		} else if (entry.result.startsWith('already_')) {
			lines.push(`somente admins falam: já estava ${action}`)
		} else {
			lines.push(`pediu: somente admins falam ${action}`)
		}
	}

	const removedFrom = asList(f.removedFrom)
	if (removedFrom.length) lines.push(`saiu de: ${removedFrom.map(groupName).join(', ')}`)

	const community = asString(f.community)
	if (community && f.reach === 'community') lines.push(`alcance: comunidade ${groupName(community)}`)
	if (f.reach === 'group') lines.push('alcance: só este grupo')

	const reason = asString(f.reason)
	if (reason) lines.push(`motivo: ${reason}`)

	const status = asString(f.status)
	if (status && status !== '200') lines.push(`resposta do WhatsApp: ${status}${status === '403' ? ' (o bot não é admin da comunidade)' : ''}`)

	// sem o erro, um "⚠️ delete_error" no grupo de log não diz por que falhou — e é justamente nos
	// casos acionáveis (bot perdeu admin, exceção inesperada) que ele aparece.
	const err = asString(f.err)
	if (err) lines.push(`erro: ${err.slice(0, MAX_ERR)}`)

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
