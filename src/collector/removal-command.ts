// Domínio compartilhado dos comandos que REMOVEM alguém (/ban e /kick). A diferença entre os dois
// é só o alcance: o /ban vale para a comunidade inteira, o /kick só para o grupo onde foi digitado.
// Todo o resto — autorização pelo topo, resolução do alvo, guardrails, veredito honesto — é igual,
// e viver num lugar só evita que os dois divirjam silenciosamente.
//
// Remoção é um ATO, não um estado: nada é persistido sobre quem foi removido. Quem volta pelo link
// de convite entra de novo — se precisar barrar, feche o convite ou remova outra vez.
//
// Segue o mesmo espírito de command-handler.ts: a casca genérica cuida do loop e da auditoria;
// aqui mora a regra de remoção; os arquivos ban-command.ts e kick-command.ts são cascas finas.

import { createCommandHandler, requireCommunityAdmin, type CommandContext, type CommandLogger, type CommandVisibility } from './command-handler.js'
import { createCommunityDirectory, type CommunityDirectory, type DirectorySocket } from './community-directory.js'
import { resolveTarget } from './target-resolver.js'

export interface RemovalUpdateResult {
	status: string
	jid?: string
}
// Interface mínima do socket do Baileys que os handlers precisam (injetável p/ testes sem rede).
export interface RemovalSocket extends DirectorySocket {
	groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<RemovalUpdateResult[]>
	communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<RemovalUpdateResult[]>
}

// 'community': alcance máximo — sai da comunidade e de todos os subgrupos (uma chamada, cascata
// nativa do WhatsApp). 'group': sai só do grupo onde o comando foi digitado.
export type RemovalReach = 'community' | 'group'

export interface RemovalDeps {
	directory: CommunityDirectory
	reach: RemovalReach
}

// Domínio: view do escopo → autorização → alvo → guardrails → remoção.
// A autorização vem ANTES da resolução do alvo porque é a view (o diretório da comunidade) que
// traduz telefone → @lid; sem ela não há como resolver quem não está no grupo do comando.
const removalDomain = ({ directory, reach }: RemovalDeps) =>
	async ({ msg, cmd, groupJid, actor, sock, audit: baseAudit, deleteCommand }: CommandContext<RemovalSocket>): Promise<void> => {
		const view = await requireCommunityAdmin({ directory, groupJid, actor, audit: baseAudit })
		if (!view) return // já auditou group_unknown / not_authorized / directory_error

		// autorizado: a partir daqui o comando é legítimo e sai da vista do grupo. A tentativa de
		// quem NÃO passou por aqui fica onde está — o bot não apaga mensagem de quem não manda.
		await deleteCommand()

		const target = resolveTarget(msg, cmd, view)
		// todo log carrega o alvo e o escopo: embrulha o audit base uma vez, e só o wrapper
		// enriquecido fica em escopo — impossível auditar sem esse contexto.
		const audit: typeof baseAudit = (result, extra = {}) =>
			baseAudit(result, {
				target: target?.jid ?? null,
				phone: target?.phone ?? null,
				via: target?.via ?? null,
				reason: target?.reason ?? null,
				scope: view.scope,
				community: view.communityJid,
				...extra,
			})

		if (!target) {
			audit('no_target')
			return
		}

		// número parcial que casou com mais de um membro: agir seria um chute.
		if (target.via === 'phone_ambiguous') {
			audit('phone_ambiguous', { candidates: target.candidates })
			return
		}
		// número parcial que não casou com ninguém: quase sempre erro de digitação.
		if (target.via === 'phone_incomplete') {
			audit('phone_incomplete')
			return
		}
		// número completo que não está em nenhum grupo do escopo: não há de onde remover.
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
		// o /kick age sobre ESTE grupo: alvo que só está em outro subgrupo não tem o que ser tirado aqui.
		if (reach === 'group' && !target.foundIn.includes(groupJid)) {
			audit('target_not_in_group')
			return
		}

		// remoção — na comunidade é UMA chamada: linked_groups:true cascateia para todos os subgrupos.
		const member = view.findByJid(target.jid)
		const removeId = member?.rawId ?? target.jid
		const viaCommunity = reach === 'community' && view.scope === 'community' && view.communityJid

		try {
			const res = viaCommunity
				? await sock.communityParticipantsUpdate(view.communityJid!, [removeId], 'remove')
				: await sock.groupParticipantsUpdate(groupJid, [removeId], 'remove')

			const status = res?.[0]?.status ?? 'unknown'
			// status != 200 é recusa do WhatsApp (403 = bot sem admin na comunidade). Auditar isso
			// como "removed" escondia falha silenciosa — o veredito agora segue o status.
			audit(status === '200' ? 'removed' : 'remove_rejected', {
				status,
				reach: viaCommunity ? 'community' : 'group',
				removedFrom: viaCommunity ? target.foundIn : [groupJid],
			})
		} catch (err) {
			audit('remove_error', { err: String(err) })
		}
	}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createRemovalHandler = (deps: {
	name: string
	reach: RemovalReach
	sock: RemovalSocket
	logger: CommandLogger
	directory?: CommunityDirectory
	visibility?: CommandVisibility
}) =>
	createCommandHandler({
		name: deps.name,
		sock: deps.sock,
		logger: deps.logger,
		visibility: deps.visibility,
		domain: removalDomain({
			directory: deps.directory ?? createCommunityDirectory({ sock: deps.sock }),
			reach: deps.reach,
		}),
	})
