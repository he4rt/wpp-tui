// Casca compartilhada dos comandos de moderação do coletor (/ban, /kick, /admin) — a parte COM
// efeitos (socket + logger). Complementa o command-core.ts (primitivos puros). Aqui vive a
// orquestração que todo comando repete: guarda de grupo/notify, loop best-effort do lote, try/catch
// e factory de audit (createCommandHandler), mais o par metadata + autorização de admin.
//
// A auditoria é a única memória da moderação — a remoção em si não deixa registro nenhum. Por isso
// cada linha é AUTOSSUFICIENTE: quem, o quê, onde, quando e qual mensagem — sem precisar juntar com
// outra linha nem com o NDJSON cru para entender o que aconteceu.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, sentAtIso, isAdmin, type CmdMessage, type CmdMessageKey, type CmdParticipant, type CmdUpsert, type ParsedCommand } from './command-core.js'
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
	// traduz JID → nome do grupo. Sem isso o journal só mostra o JID, e quem lê precisa
	// consultar o cache de metadata para descobrir de que grupo se trata.
	groupName?: (jid: string) => string
}

// audit(result, extra?): registra uma tentativa. A casca injeta a identidade da tentativa; cada
// comando pode embrulhar para acrescentar campos fixos (o /ban acrescenta `target`, o /admin `action`).
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

// Teto do texto do comando no log: o bastante para reconhecer o que foi digitado (e um motivo
// longo), sem transformar a trilha de auditoria num arquivo de mensagens.
const MAX_TEXT = 200

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
					const text = messageText(msg)
					const cmd = parseCommand(text)
					if (cmd?.name !== name) continue // é o meu comando? (/ e !)
					const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
					// resolvido uma vez por comando: entra no journal ao lado do JID.
					const groupName = visibility?.groupName?.(groupJid)

					// Identidade da tentativa, repetida em TODA linha desta mensagem:
					//  - actorName: o @lid não diz quem é ninguém; o pushName é o que um humano reconhece.
					//  - messageId: liga a linha ao evento cru em logs/messages.upsert/ — a única forma de
					//    reencontrar o comando depois que o bot apagou a mensagem do grupo.
					//  - sentAt: quando foi DIGITADO (o horário do log é o do processamento; numa
					//    reconexão o lote chega atrasado e os dois divergem).
					//  - text: o comando como foi digitado — é o que explica um no_target ou um alvo
					//    resolvido diferente do que o moderador achava que tinha escrito.
					const trace = {
						command: name,
						actor,
						actorName: msg.pushName ?? null,
						group: groupJid,
						...(groupName ? { groupName } : {}),
						messageId: msg.key?.id ?? null,
						sentAt: sentAtIso(msg),
						text: text.slice(0, MAX_TEXT),
					}

					// apaga ANTES de decidir qualquer coisa: vale para comando autorizado e para
					// tentativa de membro comum. Quem não pode moderar nem descobre que os comandos
					// existem — a mensagem some sem nenhuma resposta.
					let deleted = false
					// por que NÃO foi apagado, quando não foi: `deleted: false` sozinho é ambíguo
					// (sala de admin? env não configurada? o revoke falhou?).
					let deleteSkip: string | null = null
					if (visibility) {
						if (!shouldDeleteCommand(visibility.config, groupJid)) {
							deleteSkip = visibility.config.moderationGroupJid ? 'private_admin_group' : 'moderation_group_unset'
						} else {
							try {
								await visibility.deleter.sendMessage(groupJid, { delete: msg.key ?? {} })
								deleted = true
							} catch (err) {
								deleteSkip = 'delete_failed'
								logger.info({ ...trace, result: 'delete_error', err: String(err) }, `${name}: falha ao apagar o comando`)
								// falhar em apagar é acionável (o bot perdeu admin no grupo): vai também
								// para o grupo de log, senão só aparece para quem lê o journal.
								void visibility.reporter.publish({
									command: name,
									result: 'delete_error',
									group: groupJid,
									actor,
									actorName: msg.pushName ?? null,
									text: trace.text,
									deleted: false,
									fields: { err: String(err) },
								})
							}
						}
					}

					const audit: Audit = (result, extra = {}) => {
						// `deleted`/`deleteSkip` só aparecem quando há visibilidade configurada — sem os
						// grupos privados definidos nada é apagado, e campos fixos seriam só ruído.
						logger.info(
							{
								...trace,
								result,
								...(visibility ? { deleted, ...(deleteSkip ? { deleteSkip } : {}) } : {}),
								...extra,
							},
							`${name}: tentativa`,
						)
						// mesmo conteúdo no grupo de log; falha ali não afeta o comando (fire-and-forget).
						void visibility?.reporter.publish({
							command: name,
							result,
							group: groupJid,
							actor,
							actorName: msg.pushName ?? null,
							text: trace.text,
							deleted,
							fields: extra,
						})
					}

					await domain({ msg, cmd, groupJid, actor, sock, audit })
				} catch (err) {
					// contexto do que se sabe SEM depender do que já foi resolvido: o erro pode ter
					// acontecido antes do trace existir, e um handler_error sem grupo nem mensagem é
					// impossível de investigar. Nada é normalizado aqui — dentro de um catch, uma
					// segunda exceção derrubaria a garantia de nunca lançar.
					logger.info(
						{
							command: name,
							result: 'handler_error',
							group: msg?.key?.remoteJid ?? null,
							actor: msg?.key?.participant ?? null,
							messageId: msg?.key?.id ?? null,
							err: String(err),
						},
						`${name}: erro inesperado`,
					)
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
		// `member` separa "membro comum tentou" de "autor nem está na lista do grupo" — o segundo
		// caso é metadata vencida ou @lid divergente, e o diagnóstico é outro.
		audit('not_admin', { member: Boolean(me) })
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
		// A recusa mais comum na prática é admin de SUBGRUPO comandando algo de comunidade. Registrar
		// `groupAdmin` distingue isso de membro comum sondando o bot — são conversas diferentes.
		const inGroup = (view.group.participants || []).find((p) => jidNormalizedUser(p.id) === actor)
		audit('not_authorized', {
			scope: view.scope,
			community: view.communityJid,
			groupAdmin: isAdmin(inGroup),
			member: Boolean(inGroup),
		})
		return null
	}
	return view
}
