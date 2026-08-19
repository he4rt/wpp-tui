// Resolução do alvo dos comandos de moderação. Puro: recebe a mensagem, o comando parseado e a
// view da comunidade; devolve quem é o alvo e de onde a informação veio.
//
// Existe por causa de um caso real (spec 2026-08-18): quando o alvo não está no grupo onde o
// comando é digitado, não há reply nem menção possível — o WhatsApp só oferece membros do próprio
// grupo. O telefone é a única forma de nomear essa pessoa, e a view da comunidade é o que traduz
// telefone → @lid varrendo os participantes de TODOS os subgrupos.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { normalizePhone, type CmdMessage, type ParsedCommand } from './command-core.js'
import type { CommunityView } from './community-directory.js'

export type TargetVia =
	| 'reply'
	| 'mention'
	| 'phone' // número completo, casou com um membro
	| 'phone_suffix' // número sem DDI (ou sem DDI e DDD) que casou com exatamente um membro
	| 'phone_pre_ban' // número completo que não está em nenhum grupo — alvo válido para pré-ban
	| 'phone_ambiguous' // final de número que casa com mais de um membro
	| 'phone_incomplete' // número parcial que não casa com ninguém — provável erro de digitação

export interface ResolvedTarget {
	jid: string | null // normalizado; null quando só temos o telefone (pré-ban) ou nada casou
	phone: string | null // só dígitos
	foundIn: string[] // JIDs dos grupos do escopo onde o alvo está (vazio no pré-ban)
	via: TargetVia
	reason: string | null // texto livre após o alvo
	candidates?: number // quantos membros casaram, quando o final do número é ambíguo
}

// Menor comprimento que ainda pode ser um número completo (DDI 2 + DDD 2 + 8 dígitos).
// Abaixo disso o moderador digitou um número parcial — tipicamente esqueceu o "55".
const FULL_PHONE_MIN = 12

// Motivo = o que sobra dos argumentos depois de tirar o que identificou o alvo.
// Menções entram no texto como "@5500900000002", então tokens iniciados por @ saem fora.
function reasonFrom(rawArgs: string[], skip: number): string | null {
	const text = rawArgs.slice(skip).filter((t) => !t.startsWith('@')).join(' ').trim()
	return text || null
}

// Só dígitos e pontuação de telefone — o que pode ser pedaço de um número digitado com espaços.
const PHONE_TOKEN = /^[+\d()\-.]+$/

// Telefone no início dos argumentos, com quantos tokens ele ocupou.
// Um token só é o caso normal ("/ban 5500900000002 spam"). Vários tokens cobrem o moderador que
// digita formatado ("/ban +55 00 90000-0001 spam") — aí vale o MAIOR prefixo que forma um número
// válido. A tentativa multi-token só acontece quando o primeiro token sozinho não serve, senão
// "/ban 5500900000002 2024" engoliria o "2024" no número.
function takePhone(rawArgs: string[]): { phone: string; consumed: number } | null {
	const first = normalizePhone(rawArgs[0])
	if (first) return { phone: first, consumed: 1 }

	let span = 0
	while (span < rawArgs.length && PHONE_TOKEN.test(rawArgs[span])) span++
	for (let k = span; k >= 2; k--) {
		const phone = normalizePhone(rawArgs.slice(0, k).join(''))
		if (phone) return { phone, consumed: k }
	}
	return null
}

function describe(rawJid: string, via: TargetVia, view: CommunityView, reason: string | null): ResolvedTarget {
	const jid = jidNormalizedUser(rawJid)
	const member = view.findByJid(jid)
	return {
		jid,
		// alvo vindo de reply/menção pode não ter telefone conhecido (grupo endereçado por PN, ou
		// participante sem phone_number na metadata) — o ban funciona igual, a denylist casa por jid.
		phone: member?.phone ?? normalizePhone(jid),
		foundIn: member?.groups ?? [],
		via,
		reason,
	}
}

// Precedência: reply > menção > telefone. Reply exige stanzaId + participant juntos (contextInfo
// sozinho aparece em encaminhamentos e geraria falso positivo).
export function resolveTarget(msg: CmdMessage, cmd: ParsedCommand, view: CommunityView): ResolvedTarget | null {
	const ctx = msg.message?.extendedTextMessage?.contextInfo

	if (ctx?.stanzaId && ctx.participant) {
		return describe(ctx.participant, 'reply', view, reasonFrom(cmd.rawArgs, 0))
	}
	if (ctx?.mentionedJid?.length) {
		return describe(ctx.mentionedJid[0], 'mention', view, reasonFrom(cmd.rawArgs, 0))
	}

	const taken = takePhone(cmd.rawArgs)
	if (!taken) return null

	const { phone } = taken
	const reason = reasonFrom(cmd.rawArgs, taken.consumed)

	const member = view.findByPhone(phone)
	if (member) {
		return { jid: member.jid, phone, foundIn: member.groups, via: 'phone', reason }
	}

	// Número parcial: o erro mais comum é esquecer o DDI. Em vez de recusar (ou, pior, tratar
	// como pré-ban de um número que não existe), procura quem TERMINA com o que foi digitado.
	if (phone.length < FULL_PHONE_MIN) {
		const matches = view.findByPhoneSuffix(phone)
		if (matches.length === 1) {
			const hit = matches[0]
			return { jid: hit.jid, phone: hit.phone ?? phone, foundIn: hit.groups, via: 'phone_suffix', reason }
		}
		if (matches.length > 1) {
			// dois membros com o mesmo final: agir seria um chute. Devolve para o comando recusar.
			return { jid: null, phone, foundIn: [], via: 'phone_ambiguous', reason, candidates: matches.length }
		}
		// nada casou e o número está incompleto — quase sempre erro de digitação, não pré-ban.
		return { jid: null, phone, foundIn: [], via: 'phone_incomplete', reason }
	}

	// número COMPLETO que não está em nenhum grupo do escopo: vira pré-ban (só denylist).
	return { jid: null, phone, foundIn: [], via: 'phone_pre_ban', reason }
}
