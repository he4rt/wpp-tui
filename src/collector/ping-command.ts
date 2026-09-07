import { createCommandHandler, type CommandLogger } from './command-handler.js'

export interface PingSocket {
	sendMessage(jid: string, content: { text: string }): Promise<unknown>
}

// Disponível para qualquer membro do grupo, sem consultar permissões de moderação.
export const createPingHandler = (deps: { sock: PingSocket; logger: CommandLogger }) =>
	createCommandHandler({
		name: 'ping',
		...deps,
		domain: async ({ sock, groupJid, audit }) => {
			await sock.sendMessage(groupJid, { text: '🏓 Pong! Estou online.' })
			audit('ok')
		},
	})
