// Registro de mensagem apagada por outra pessoa — tipicamente um admin moderando o grupo.
//
// Apagar a mensagem de um membro é um ato de moderação como qualquer outro, e até aqui não deixava
// rastro nenhum: o conteúdo saía do grupo e ninguém mais sabia o que havia sido dito, nem por quem
// foi tirado. Este observador fecha esse buraco na trilha.
//
// O gancho é o `messages.update` com `messageStubType: REVOKE` (visto nos logs reais). Ele traz as
// duas pontas de que precisamos: `key.participant` é o AUTOR da mensagem apagada, e
// `update.key.participant` é QUEM apagou.
//
// Só registra apagamento de mensagem de TERCEIRO. Quem apaga a própria mensagem não está moderando
// ninguém — é arrependimento, e vigiar isso seria transformar a trilha de moderação em vigilância
// de conversa. O apagamento que o próprio bot faz (a mensagem de um comando de moderação) também
// fica fora: aquilo já é auditado como comando, e registrar de novo aqui duplicaria cada /ban.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type { CommandLogger } from './command-handler.js'
import type { MessageLookup } from './message-lookup.js'

// WAMessageStubType.REVOKE — "esta mensagem foi apagada".
const REVOKE = 1

// Teto do conteúdo apagado no registro. Uma mensagem longa apagada continua reconhecível pelo
// começo, e o NDJSON cru guarda o texto inteiro para quem precisar do resto.
const MAX_TEXT = 300

export interface DeletionKey {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
	fromMe?: boolean | null
}
export interface DeletionUpdate {
	key?: DeletionKey | null // chave da mensagem APAGADA
	update?: {
		messageStubType?: number | null
		key?: DeletionKey | null // chave do protocolo de revogação — traz quem apagou
	} | null
}

// Publicador do grupo de log (o mesmo usado pelo relatório dos comandos).
export interface DeletionPublisher {
	send(text: string): Promise<void>
}

export interface DeletionEvent {
	group: string
	groupName: string | null
	deletedBy: string // @lid de quem apagou
	author: string // @lid do autor da mensagem
	authorName: string | null // pushName do autor, quando o log da mensagem tinha
	messageId: string
	sentAt: string | null // quando a mensagem apagada foi enviada
	text: string | null // conteúdo apagado, truncado
	kind: string | null // tipo do que foi apagado (texto, imagem, áudio…)
}

// Monta o texto publicado no grupo de log. Puro — o teste cobre a formatação sem socket.
export function formatDeletion(e: DeletionEvent): string {
	const lines = [
		'🗑️ mensagem apagada por outra pessoa',
		`grupo: ${e.groupName ?? e.group}`,
		`apagou: ${e.deletedBy || '?'}`,
		`autor: ${e.authorName ? `${e.authorName} · ` : ''}${e.author || '?'}`,
	]
	if (e.sentAt) lines.push(`enviada em: ${e.sentAt}`)
	if (e.text) lines.push(`conteúdo: ${e.text}`)
	// sem o conteúdo o registro ainda vale (quem apagou o quê de quem), mas dizer POR QUE ele falta
	// evita a leitura errada de "mensagem vazia".
	else lines.push(`conteúdo: não recuperado${e.kind && e.kind !== 'conversation' ? ` (${e.kind})` : ''} — id ${e.messageId}`)
	return lines.join('\n')
}

export function createDeletionWatcher(deps: {
	logger: CommandLogger
	lookup: MessageLookup
	// identidades do próprio bot (PN e @lid): apagamento feito por ele já é auditado como comando.
	self?: () => Array<string | null | undefined>
	groupName?: (jid: string) => string
	publisher?: DeletionPublisher
}) {
	const { logger, lookup } = deps

	const isSelf = (jid: string): boolean =>
		(deps.self?.() ?? []).some((mine) => Boolean(mine) && jidNormalizedUser(mine!) === jid)

	return {
		// best-effort: nunca lança (não pode derrubar a coleta).
		async handle(updates: DeletionUpdate[]): Promise<void> {
			try {
				for (const item of updates || []) {
					if (item?.update?.messageStubType !== REVOKE) continue

					const group = item.key?.remoteJid
					if (!group?.endsWith('@g.us')) continue // DM não é moderação de grupo

					const author = item.key?.participant ? jidNormalizedUser(item.key.participant) : ''
					const deletedBy = item.update?.key?.participant ? jidNormalizedUser(item.update.key.participant) : ''
					const messageId = item.key?.id ?? ''

					// apagou a própria mensagem: não é moderação, não entra na trilha.
					if (!author || !deletedBy || author === deletedBy) continue
					// o próprio bot apagando o comando de um moderador: já auditado como comando.
					if (item.update?.key?.fromMe === true || isSelf(deletedBy)) continue

					const logged = await lookup.find(messageId).catch(() => null)
					const event: DeletionEvent = {
						group,
						groupName: deps.groupName?.(group) ?? null,
						deletedBy,
						author,
						authorName: logged?.pushName ?? null,
						messageId,
						sentAt: logged?.sentAt ?? null,
						text: logged?.text ? logged.text.slice(0, MAX_TEXT) : null,
						kind: logged?.kind ?? null,
					}

					logger.info(
						{
							event: 'message_deleted',
							group: event.group,
							...(event.groupName ? { groupName: event.groupName } : {}),
							deletedBy: event.deletedBy,
							author: event.author,
							authorName: event.authorName,
							messageId: event.messageId,
							sentAt: event.sentAt,
							kind: event.kind,
							text: event.text,
							recovered: Boolean(event.text),
						},
						'moderação: mensagem apagada por outra pessoa',
					)

					// falha ao publicar não afeta o registro no journal (fire-and-forget).
					void deps.publisher?.send(formatDeletion(event))
				}
			} catch (err) {
				logger.info({ event: 'message_deleted', result: 'handler_error', err: String(err) }, 'moderação: erro ao registrar apagamento')
			}
		},
	}
}
