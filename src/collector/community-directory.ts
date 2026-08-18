// Diretório da comunidade: quem está em quais grupos, quem manda, e como achar alguém pelo
// telefone. É o que permite ao /ban alcançar um alvo que NÃO está no grupo onde o comando foi
// digitado — a limitação que travava a moderação (spec 2026-08-18).
//
// Fonte: groupFetchAllParticipating() — uma chamada devolve todos os grupos do bot com
// participants[], linkedParent e, em grupos endereçados por LID, o phoneNumber de cada membro.
// O resultado é cacheado por TTL: um /ban é raro, mas vem em rajada (moderador corrigindo a mão).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { normalizePhone, type CmdParticipant } from './command-core.js'

// Shapes mínimos da metadata do Baileys que o diretório consome — locais para os testes usarem
// objetos simples. A GroupMetadata real é estruturalmente compatível.
export interface DirParticipant extends CmdParticipant {
	phoneNumber?: string | null // presente quando o grupo endereça por @lid
}
export interface DirGroupMetadata {
	id: string
	subject?: string | null
	owner?: string | null
	linkedParent?: string | null
	isCommunity?: boolean | null
	participants: DirParticipant[]
}
export interface DirectorySocket {
	groupFetchAllParticipating(): Promise<Record<string, DirGroupMetadata>>
	groupMetadata(jid: string): Promise<DirGroupMetadata>
}

// Um membro localizado no diretório, já com os grupos onde ele aparece.
export interface DirectoryMember {
	jid: string // normalizado (@lid ou @s.whatsapp.net) — usado para comparar
	rawId: string // id exatamente como veio na lista de participantes — usado para remover
	phone: string | null // só dígitos
	groups: string[] // JIDs dos grupos onde está
}

// O recorte visto por um comando: o grupo onde ele foi digitado + o escopo que ele alcança.
export interface CommunityView {
	group: DirGroupMetadata // grupo do comando
	communityJid: string | null // null em grupo standalone (sem linkedParent)
	communityName: string | null
	scope: 'community' | 'group' // de onde vem a autoridade e até onde o ban alcança
	groups: DirGroupMetadata[] // grupos alcançados (comunidade inteira, ou só o grupo)
	admins: Set<string> // quem pode comandar: admins da comunidade, ou do grupo se standalone
	owners: Set<string> // owner do grupo + da comunidade — nunca banível
	findByJid(jid: string): DirectoryMember | null
	findByPhone(phone: string): DirectoryMember | null
}

export interface CommunityDirectory {
	viewFor(groupJid: string): Promise<CommunityView | null>
	invalidate(): void
}

const adminOf = (p: CmdParticipant) => p.admin === 'admin' || p.admin === 'superadmin'

// Monta a view a partir de um snapshot já carregado. Puro — o teste cobre a montagem sem rede.
export function buildView(snapshot: Record<string, DirGroupMetadata>, groupJid: string, community: DirGroupMetadata | null): CommunityView | null {
	const group = snapshot[groupJid]
	if (!group) return null

	const communityJid = group.linkedParent ? jidNormalizedUser(group.linkedParent) : null
	// O escopo é a comunidade quando o grupo é subgrupo E temos a metadata do pai (é dela que sai a
	// lista de admins). Sem o pai, degradamos para o próprio grupo em vez de recusar o comando.
	const scope: 'community' | 'group' = communityJid && community ? 'community' : 'group'

	const groups = scope === 'community'
		? Object.values(snapshot).filter((g) => g.linkedParent && jidNormalizedUser(g.linkedParent) === communityJid)
		: [group]

	const authority = scope === 'community' ? community! : group
	const admins = new Set(authority.participants.filter(adminOf).map((p) => jidNormalizedUser(p.id)))

	const owners = new Set<string>()
	if (group.owner) owners.add(jidNormalizedUser(group.owner))
	if (community?.owner) owners.add(jidNormalizedUser(community.owner))

	// índices de busca: um membro pode estar em vários grupos do escopo.
	const byJid = new Map<string, DirectoryMember>()
	const byPhone = new Map<string, DirectoryMember>()
	for (const g of groups) {
		for (const p of g.participants) {
			const jid = jidNormalizedUser(p.id)
			let member = byJid.get(jid)
			if (!member) {
				member = { jid, rawId: p.id, phone: normalizePhone(p.phoneNumber), groups: [] }
				byJid.set(jid, member)
			}
			// o phoneNumber pode vir só em alguns grupos — o primeiro que aparecer vale.
			member.phone ??= normalizePhone(p.phoneNumber)
			member.groups.push(g.id)
			if (member.phone) byPhone.set(member.phone, member)
		}
	}

	return {
		group,
		communityJid: scope === 'community' ? communityJid : null,
		communityName: scope === 'community' ? (community?.subject ?? null) : null,
		scope,
		groups,
		admins,
		owners,
		findByJid: (jid) => byJid.get(jidNormalizedUser(jid)) ?? null,
		findByPhone: (phone) => byPhone.get(phone) ?? null,
	}
}

// Diretório com cache por TTL. `now` é injetável p/ teste; ttlMs=0 desliga o cache.
export function createCommunityDirectory(deps: { sock: DirectorySocket; ttlMs?: number; now?: () => number }): CommunityDirectory {
	const { sock } = deps
	const ttlMs = deps.ttlMs ?? 60_000
	const now = deps.now ?? Date.now

	let snapshot: Record<string, DirGroupMetadata> | null = null
	let fetchedAt = 0
	// promessa em voo compartilhada: uma rajada de comandos não dispara N fetches.
	let inflight: Promise<Record<string, DirGroupMetadata>> | null = null

	async function load(force = false): Promise<Record<string, DirGroupMetadata>> {
		if (!force && snapshot && now() - fetchedAt < ttlMs) return snapshot
		if (inflight) return inflight
		inflight = sock
			.groupFetchAllParticipating()
			.then((result) => {
				snapshot = result
				fetchedAt = now()
				return result
			})
			.finally(() => {
				inflight = null
			})
		return inflight
	}

	return {
		invalidate() {
			snapshot = null
			fetchedAt = 0
		},

		async viewFor(groupJid) {
			let snap = await load()
			// grupo ausente do snapshot (bot entrou agora, cache velho): força UM refresh antes de desistir.
			if (!snap[groupJid]) snap = await load(true)
			const group = snap[groupJid]
			if (!group) return null

			let community: DirGroupMetadata | null = null
			if (group.linkedParent) {
				const parentJid = group.linkedParent
				community = snap[parentJid] ?? null
				// o JID da comunidade nem sempre volta no participating — busca direto nesse caso.
				if (!community) {
					try {
						community = await sock.groupMetadata(parentJid)
					} catch {
						community = null // sem o pai, buildView degrada para escopo de grupo
					}
				}
			}

			return buildView(snap, groupJid, community)
		},
	}
}
