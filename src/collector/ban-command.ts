// Comando de moderação /ban: remove alguém da comunidade inteira (grupo + todos os subgrupos).
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// A casca (loop best-effort, guarda de grupo/notify, audit) vem de command-handler.
//
// Escopo de COMUNIDADE (spec 2026-08-18): a autoridade é ser admin no JID da comunidade pai, o
// alvo pode estar em qualquer subgrupo (identificado por reply, menção ou telefone), e o veredito
// de auditoria respeita o status devolvido pelo WhatsApp — 403 não é "removed".

import { messageText, parseCommand, type CmdMessage } from './command-core.js'
import { createCommandHandler, requireCommunityAdmin, type CommandContext, type CommandLogger } from './command-handler.js'
import { createCommunityDirectory, type CommunityDirectory, type DirectorySocket } from './community-directory.js'
import { resolveTarget } from './target-resolver.js'

// Compat: BanMessage é o shape genérico de mensagem compartilhado (command-core).
export type BanMessage = CmdMessage
export { messageText }

// Detecta o comando /ban — aceita "/ban" e "!ban" (case-insensitive) pelo primeiro token.
export function parseBanCommand(text: string): boolean {
	return parseCommand(text)?.name === 'ban'
}

// ---- handler ----

export interface BanUpdateResult {
	status: string
	jid?: string
}
// Interface mínima do socket do Baileys que o handler precisa (injetável p/ testes sem rede).
export interface BanSocket extends DirectorySocket {
	groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
	communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
}

// Domínio do /ban: view do escopo → autorização → alvo → guardrails → remoção.
// A autorização vem ANTES da resolução do alvo porque é a view (o diretório da comunidade) que
// traduz telefone → @lid; sem ela não há como resolver quem não está no grupo do comando.
const banDomain = (directory: CommunityDirectory) =>
	async ({ msg, cmd, groupJid, actor, sock, audit: baseAudit }: CommandContext<BanSocket>): Promise<void> => {
		const view = await requireCommunityAdmin({ directory, groupJid, actor, audit: baseAudit })
		if (!view) return // já auditou group_unknown / not_authorized / directory_error

		const target = resolveTarget(msg, cmd, view)
		// todo log do ban carrega o alvo e o escopo: embrulha o audit base uma vez, e só o wrapper
		// enriquecido fica em escopo — impossível auditar sem esse contexto.
		const audit: typeof baseAudit = (result, extra = {}) =>
			baseAudit(result, {
				target: target?.jid ?? null,
				phone: target?.phone ?? null,
				via: target?.via ?? null,
				scope: view.scope,
				community: view.communityJid,
				...extra,
			})

		if (!target) {
			audit('no_target')
			return
		}
		// número válido fora da comunidade: sem denylist ainda não há o que fazer com ele.
		if (!target.jid) {
			audit('target_not_found')
			return
		}

		// guardrails
		if (target.jid === actor) {
			audit('self_ban')
			return
		}
		if (view.admins.has(target.jid)) {
			// admin de SUBGRUPO não entra aqui: a proteção é só para o topo (decisão da spec).
			audit(view.scope === 'community' ? 'target_is_community_admin' : 'target_is_admin')
			return
		}
		if (view.owners.has(target.jid)) {
			audit('target_is_owner')
			return
		}
		if (target.foundIn.length === 0) {
			audit('target_not_member')
			return
		}

		// remoção — na comunidade é UMA chamada: linked_groups:true cascateia para todos os subgrupos.
		const member = view.findByJid(target.jid)
		const removeId = member?.rawId ?? target.jid
		try {
			const res = view.scope === 'community' && view.communityJid
				? await sock.communityParticipantsUpdate(view.communityJid, [removeId], 'remove')
				: await sock.groupParticipantsUpdate(groupJid, [removeId], 'remove')

			const status = res?.[0]?.status ?? 'unknown'
			// status != 200 é recusa do WhatsApp (403 = bot sem admin na comunidade). Auditar isso
			// como "removed" escondia falha silenciosa — o veredito agora segue o status.
			audit(status === '200' ? 'removed' : 'remove_rejected', { status, removedFrom: target.foundIn, reason: target.reason })
		} catch (err) {
			audit('remove_error', { err: String(err) })
		}
	}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createBanHandler = (deps: { sock: BanSocket; logger: CommandLogger; directory?: CommunityDirectory }) =>
	createCommandHandler({
		name: 'ban',
		sock: deps.sock,
		logger: deps.logger,
		domain: banDomain(deps.directory ?? createCommunityDirectory({ sock: deps.sock })),
	})
