// Casca compartilhada dos comandos de moderação do coletor (/ban, /admin) — a parte COM efeitos
// (socket + logger). Complementa o command-core.ts (primitivos puros). Aqui vive a orquestração que
// todo comando repete: guarda de grupo/notify, loop best-effort do lote, try/catch e factory de
// audit (createCommandHandler), mais o par metadata + autorização de admin (requireGroupAdmin).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdParticipant, type CmdUpsert } from './command-core.js'

export interface CommandLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}

// audit(result, extra?): registra uma tentativa. A casca injeta { actor, group }; cada comando pode
// embrulhar para acrescentar campos fixos (o /ban acrescenta `target`, o /admin `action`).
export type Audit = (result: string, extra?: Record<string, unknown>) => void

// Contexto entregue ao domínio de cada comando. Genérico no socket (S) para cada comando expor o
// seu próprio shape de sock (BanSocket / AdminSocket) já tipado dentro do ctx.
export interface CommandContext<S> {
	msg: CmdMessage
	groupJid: string
	actor: string
	sock: S
	audit: Audit
}

// Fábrica da casca: nome do comando (sem prefixo) + socket + logger + a regra de domínio.
// Retorna { handle(upsert) } best-effort — nunca lança (não pode derrubar a coleta).
export function createCommandHandler<S>(deps: {
	name: string
	sock: S
	logger: CommandLogger
	domain: (ctx: CommandContext<S>) => Promise<void>
}) {
	const { name, sock, logger, domain } = deps
	return {
		async handle(upsert: CmdUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					const groupJid = msg.key?.remoteJid
					if (!groupJid || !groupJid.endsWith('@g.us')) continue // só grupos
					if (parseCommand(messageText(msg))?.name !== name) continue // é o meu comando? (/ e !)
					const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
					const audit: Audit = (result, extra = {}) =>
						logger.info({ actor, group: groupJid, result, ...extra }, `${name}: tentativa`)
					await domain({ msg, groupJid, actor, sock, audit })
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, `${name}: erro inesperado`)
				}
			}
		},
	}
}

// Autorização compartilhada: busca a metadata do grupo e confirma que o autor é admin/superadmin.
// Chamada PELO domínio (não pela casca) — assim cada comando valida a própria entrada ANTES da
// autorização, exatamente como era antes da refatoração.
// Retorna a metadata (tipada por comando) se autorizado; senão audita e retorna null.
export async function requireGroupAdmin<M extends { participants: CmdParticipant[] }>(deps: {
	sock: { groupMetadata(jid: string): Promise<M> }
	groupJid: string
	actor: string
	audit: Audit
}): Promise<M | null> {
	const { sock, groupJid, actor, audit } = deps
	let meta: M
	try {
		meta = await sock.groupMetadata(groupJid)
	} catch (err) {
		audit('metadata_error', { err: String(err) })
		return null
	}
	const me = (meta.participants || []).find((p) => jidNormalizedUser(p.id) === actor)
	if (!isAdmin(me)) {
		audit('not_admin')
		return null
	}
	return meta
}
