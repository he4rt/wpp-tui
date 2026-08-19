// Casca compartilhada dos comandos de moderação do coletor (/ban, /admin) — a parte COM efeitos
// (socket + logger). Complementa o command-core.ts (primitivos puros). Aqui vive a orquestração que
// todo comando repete: guarda de grupo/notify, loop best-effort do lote, try/catch e factory de
// audit (createCommandHandler), mais o par metadata + autorização de admin (requireGroupAdmin).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdMessageKey, type CmdParticipant, type CmdUpsert, type ParsedCommand } from './command-core.js'
import type { CommunityDirectory, CommunityView } from './community-directory.js'
import { shouldDeleteCommand, type ModerationConfig } from './moderation-config.js'
import type { ModerationReporter } from './moderation-report.js'

export interface CommandLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}

// Socket mínimo para revogar a mensagem do comando (o mesmo sendMessage já usado pelo reporter).
export interface CommandDeleter {
	sendMessage(jid: string, content: { delete: CmdMessageKey }): Promise<unknown>
}

// Ligação com os grupos privados de admin: onde não apagar e para onde reportar.
// Ausente → comportamento de antes (nada apagado, nada publicado; só o journal).
export interface CommandVisibility {
	config: ModerationConfig
	deleter: CommandDeleter
	reporter: ModerationReporter
}

// audit(result, extra?): registra uma tentativa. A casca injeta { actor, group }; cada comando pode
// embrulhar para acrescentar campos fixos (o /ban acrescenta `target`, o /admin `action`).
export type Audit = (result: string, extra?: Record<string, unknown>) => void

// Contexto entregue ao domínio de cada comando. Genérico no socket (S) para cada comando expor o
// seu próprio shape de sock (BanSocket / AdminSocket) já tipado dentro do ctx.
export interface CommandContext<S> {
	msg: CmdMessage
	cmd: ParsedCommand // já parseado pela casca — o domínio não re-parseia
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
	visibility?: CommandVisibility
}) {
	const { name, sock, logger, domain, visibility } = deps
	return {
		async handle(upsert: CmdUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					const groupJid = msg.key?.remoteJid
					if (!groupJid || !groupJid.endsWith('@g.us')) continue // só grupos
					const cmd = parseCommand(messageText(msg))
					if (cmd?.name !== name) continue // é o meu comando? (/ e !)
					const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''

					// apaga ANTES de decidir qualquer coisa: vale para comando autorizado e para
					// tentativa de membro comum. Quem não pode moderar nem descobre que os comandos
					// existem — a mensagem some sem nenhuma resposta.
					let deleted = false
					if (visibility && shouldDeleteCommand(visibility.config, groupJid)) {
						try {
							await visibility.deleter.sendMessage(groupJid, { delete: msg.key ?? {} })
							deleted = true
						} catch (err) {
							logger.info({ actor, group: groupJid, result: 'delete_error', err: String(err) }, `${name}: falha ao apagar o comando`)
						}
					}

					const audit: Audit = (result, extra = {}) => {
						// `deleted` só aparece quando há visibilidade configurada — sem os grupos privados
						// definidos nada é apagado, e um campo fixo em false seria só ruído no journal.
						logger.info({ actor, group: groupJid, result, ...(visibility ? { deleted } : {}), ...extra }, `${name}: tentativa`)
						// mesmo conteúdo no grupo de log; falha ali não afeta o comando (fire-and-forget).
						void visibility?.reporter.publish({
							command: name,
							result,
							group: groupJid,
							actor,
							actorName: msg.pushName ?? null,
							deleted,
							fields: extra,
						})
					}

					await domain({ msg, cmd, groupJid, actor, sock, audit })
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

// Autorização dos comandos que agem sobre a comunidade (/ban e derivados).
// Substitui o requireGroupAdmin para esses casos: o poder vem do TOPO — admin/superadmin no JID da
// comunidade pai —, não do grupo onde o comando foi digitado. Grupos sem comunidade degradam para
// admin do próprio grupo, que é o único topo que existe ali.
// Devolve a view do escopo (grupos alcançados + índices de busca do alvo) se autorizado.
export async function requireCommunityAdmin(deps: {
	directory: CommunityDirectory
	groupJid: string
	actor: string
	audit: Audit
}): Promise<CommunityView | null> {
	const { directory, groupJid, actor, audit } = deps

	let view: CommunityView | null
	try {
		view = await directory.viewFor(groupJid)
	} catch (err) {
		audit('directory_error', { err: String(err) })
		return null
	}
	if (!view) {
		audit('group_unknown')
		return null
	}
	if (!view.admins.has(actor)) {
		audit('not_authorized', { scope: view.scope })
		return null
	}
	return view
}
