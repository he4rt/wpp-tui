// Comando de moderação /kick: remove alguém APENAS do grupo onde o comando foi digitado.
// É o irmão brando do /ban — para quem aprontou num grupo mas continua sendo membro legítimo da
// comunidade: sai daqui, permanece nos outros subgrupos e pode voltar.
//
// A regra de remoção é compartilhada com o /ban (removal-command.ts); aqui fica só o nome do
// comando e o alcance de GRUPO. A autorização é a mesma dos demais comandos de moderação: admin
// da comunidade — previsibilidade vale mais que graduar poder por tipo de comando.

import { messageText, parseCommand, type CmdMessage } from './command-core.js'
import type { CommandLogger, CommandVisibility } from './command-handler.js'
import type { CommunityDirectory } from './community-directory.js'
import { createRemovalHandler, type RemovalSocket } from './removal-command.js'

export type KickMessage = CmdMessage
export type KickSocket = RemovalSocket
export { messageText }

// Detecta o comando /kick — aceita "/kick" e "!kick" (case-insensitive) pelo primeiro token.
export function parseKickCommand(text: string): boolean {
	return parseCommand(text)?.name === 'kick'
}

export const createKickHandler = (deps: {
	sock: KickSocket
	logger: CommandLogger
	directory?: CommunityDirectory
	visibility?: CommandVisibility
}) => createRemovalHandler({ name: 'kick', reach: 'group', ...deps })
