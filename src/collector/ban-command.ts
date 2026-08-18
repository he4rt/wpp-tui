// Comando de moderação /ban: remove alguém da comunidade inteira (grupo + todos os subgrupos).
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
//
// A regra de remoção (autorização pelo topo, resolução do alvo, guardrails, veredito honesto) é
// compartilhada com o /kick e vive em removal-command.ts; aqui fica só o que é do /ban: o nome do
// comando e o alcance de COMUNIDADE.

import { messageText, parseCommand, type CmdMessage } from './command-core.js'
import type { CommandLogger } from './command-handler.js'
import type { CommunityDirectory } from './community-directory.js'
import type { ModerationDenylist } from './moderation-denylist.js'
import { createRemovalHandler, type RemovalSocket, type RemovalUpdateResult } from './removal-command.js'

// Compat: os tipos do /ban são os do domínio de remoção.
export type BanMessage = CmdMessage
export type BanSocket = RemovalSocket
export type BanUpdateResult = RemovalUpdateResult
export { messageText }

// Detecta o comando /ban — aceita "/ban" e "!ban" (case-insensitive) pelo primeiro token.
export function parseBanCommand(text: string): boolean {
	return parseCommand(text)?.name === 'ban'
}

export const createBanHandler = (deps: {
	sock: BanSocket
	logger: CommandLogger
	directory?: CommunityDirectory
	denylist?: ModerationDenylist // sem ela o /ban vira remoção simples: a reentrada não é barrada
	now?: () => Date
}) => createRemovalHandler({ name: 'ban', reach: 'community', ...deps })
