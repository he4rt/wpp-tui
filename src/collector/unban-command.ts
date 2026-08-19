// Comando de moderação /unban: tira alguém da denylist.
//
// É o desfazer do /ban — e só isso. NÃO readiciona a pessoa: o WhatsApp não permite que o bot
// coloque alguém num grupo sem convite, então o retorno é sempre pelo link. O que o /unban faz é
// destravar a porta: enquanto a entrada estiver na denylist, o enforcer desfaz qualquer reentrada.
//
// Por que não reusa o removal-command: aqui não há remoção, guardrail de alvo nem chamada de rede.
// O alvo, por definição, JÁ SAIU dos grupos — então quase sempre é identificado pelo telefone, e
// resolveTarget o devolve como pré-ban (jid nulo, telefone preenchido). Casar por telefone é o
// caminho normal deste comando, não a exceção.

import { messageText, parseCommand, type CmdMessage } from './command-core.js'
import { createCommandHandler, requireCommunityAdmin, type CommandContext, type CommandLogger, type CommandVisibility } from './command-handler.js'
import { createCommunityDirectory, type CommunityDirectory, type DirectorySocket } from './community-directory.js'
import { resolveTarget } from './target-resolver.js'
import type { ModerationDenylist } from './moderation-denylist.js'

export type UnbanMessage = CmdMessage
export type UnbanSocket = DirectorySocket
export { messageText }

// Detecta o comando /unban — aceita "/unban" e "!unban" (case-insensitive) pelo primeiro token.
export function parseUnbanCommand(text: string): boolean {
	return parseCommand(text)?.name === 'unban'
}

const unbanDomain = (directory: CommunityDirectory, denylist: ModerationDenylist) =>
	async ({ msg, cmd, groupJid, actor, audit: baseAudit }: CommandContext<UnbanSocket>): Promise<void> => {
		const view = await requireCommunityAdmin({ directory, groupJid, actor, audit: baseAudit })
		if (!view) return // já auditou group_unknown / not_authorized / directory_error

		const target = resolveTarget(msg, cmd, view)
		const audit: typeof baseAudit = (result, extra = {}) =>
			baseAudit(result, {
				target: target?.jid ?? null,
				phone: target?.phone ?? null,
				via: target?.via ?? null,
				community: view.communityJid,
				...extra,
			})

		if (!target) {
			audit('no_target')
			return
		}
		if (target.via === 'phone_ambiguous') {
			audit('phone_ambiguous', { candidates: target.candidates })
			return
		}

		// Diferente do /ban, um número parcial que não casa com ninguém NÃO é erro aqui: o banido
		// saiu dos grupos, então ele nunca aparece na busca por membro. O que vale é o que está na
		// denylist — tenta remover pelo número como foi digitado.
		const removed = denylist.remove({ lid: target.jid, phone: target.phone })
		if (!removed) {
			audit('not_in_denylist')
			return
		}

		// o retorno depende de link de convite — o bot não readiciona ninguém.
		audit('unbanned', { bannedAt: removed.at, bannedBy: removed.by, bannedReason: removed.reason })
	}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createUnbanHandler = (deps: {
	sock: UnbanSocket
	logger: CommandLogger
	denylist: ModerationDenylist
	directory?: CommunityDirectory
	visibility?: CommandVisibility
}) =>
	createCommandHandler({
		name: 'unban',
		sock: deps.sock,
		logger: deps.logger,
		visibility: deps.visibility,
		domain: unbanDomain(deps.directory ?? createCommunityDirectory({ sock: deps.sock }), deps.denylist),
	})
