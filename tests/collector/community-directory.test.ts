import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildView, createCommunityDirectory } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata, DirectorySocket } from '../../src/collector/community-directory.js'

// topologia de exemplo: comunidade + 3 subgrupos + 1 grupo solto.
const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const MARKETING = '120363000000000003@g.us'
const MOD = '120363000000000004@g.us'
const SOLTO = '120363000000000009@g.us'

const ADMIN_COM = '100000000000001@lid'
const ADMIN_SUB = '100000000000003@lid'
const VITIMA = '100000000000004@lid'
const VITIMA_PN = '5500900000001@s.whatsapp.net'

const community: DirGroupMetadata = {
	id: COMMUNITY,
	subject: 'Comunidade Exemplo',
	owner: ADMIN_COM,
	isCommunity: true,
	participants: [
		{ id: ADMIN_COM, admin: 'superadmin' },
		{ id: '100000000000002@lid', admin: 'admin' },
	],
}
const general: DirGroupMetadata = {
	id: GENERAL,
	subject: 'Grupo Geral',
	owner: ADMIN_COM,
	linkedParent: COMMUNITY,
	participants: [
		{ id: ADMIN_SUB, admin: 'admin' },
		{ id: ADMIN_COM, admin: null },
	],
}
const marketing: DirGroupMetadata = {
	id: MARKETING,
	subject: 'Grupo Secundário',
	linkedParent: COMMUNITY,
	participants: [{ id: VITIMA, phoneNumber: VITIMA_PN, admin: null }],
}
const moderacao: DirGroupMetadata = {
	id: MOD,
	subject: 'Moderação',
	linkedParent: COMMUNITY,
	participants: [{ id: ADMIN_COM, admin: 'admin' }],
}
const solto: DirGroupMetadata = {
	id: SOLTO,
	subject: 'Grupo Solto',
	owner: ADMIN_SUB,
	participants: [
		{ id: ADMIN_SUB, admin: 'admin' },
		{ id: VITIMA, phoneNumber: VITIMA_PN, admin: null },
	],
}

const snapshot: Record<string, DirGroupMetadata> = {
	[COMMUNITY]: community,
	[GENERAL]: general,
	[MARKETING]: marketing,
	[MOD]: moderacao,
	[SOLTO]: solto,
}

// ---- buildView (puro) ----

test('buildView: subgrupo enxerga a comunidade inteira, com os admins vindos do pai', () => {
	const view = buildView(snapshot, GENERAL, community)!
	assert.equal(view.scope, 'community')
	assert.equal(view.communityJid, COMMUNITY)
	assert.equal(view.communityName, 'Comunidade Exemplo')
	assert.deepEqual(view.groups.map((g) => g.id).sort(), [GENERAL, MARKETING, MOD].sort())
	// autoridade vem da comunidade: admin de subgrupo NÃO entra
	assert.equal(view.admins.has(ADMIN_COM), true)
	assert.equal(view.admins.has(ADMIN_SUB), false)
})

test('buildView: acha alguém que está só em OUTRO subgrupo (o caso que falhava)', () => {
	const view = buildView(snapshot, GENERAL, community)!
	const alvo = view.findByPhone('5500900000001')
	assert.equal(alvo?.jid, VITIMA)
	assert.deepEqual(alvo?.groups, [MARKETING])
	// e pelo jid dá no mesmo membro
	assert.equal(view.findByJid(VITIMA)?.phone, '5500900000001')
})

test('buildView: telefone fora da comunidade não resolve', () => {
	const view = buildView(snapshot, GENERAL, community)!
	assert.equal(view.findByPhone('5500900000009'), null)
})

test('buildView: grupo standalone limita escopo e autoridade ao próprio grupo', () => {
	const view = buildView(snapshot, SOLTO, null)!
	assert.equal(view.scope, 'group')
	assert.equal(view.communityJid, null)
	assert.deepEqual(view.groups.map((g) => g.id), [SOLTO])
	assert.equal(view.admins.has(ADMIN_SUB), true)
	assert.equal(view.owners.has(ADMIN_SUB), true)
})

test('buildView: subgrupo sem metadata do pai degrada para escopo de grupo', () => {
	const view = buildView(snapshot, GENERAL, null)!
	assert.equal(view.scope, 'group')
	assert.equal(view.communityJid, null)
	assert.deepEqual(view.groups.map((g) => g.id), [GENERAL])
})

test('buildView: owners junta o do grupo e o da comunidade', () => {
	const view = buildView(snapshot, MARKETING, community)!
	assert.equal(view.owners.has(ADMIN_COM), true)
})

test('buildView: grupo desconhecido → null', () => {
	assert.equal(buildView(snapshot, '000@g.us', community), null)
})

test('buildView: membro em vários grupos aparece uma vez com todos os grupos', () => {
	const emDois: Record<string, DirGroupMetadata> = {
		...snapshot,
		[MOD]: { ...moderacao, participants: [...moderacao.participants, { id: VITIMA, phoneNumber: VITIMA_PN, admin: null }] },
	}
	const view = buildView(emDois, GENERAL, community)!
	assert.deepEqual(view.findByPhone('5500900000001')?.groups.sort(), [MARKETING, MOD].sort())
})

// ---- createCommunityDirectory (cache/TTL) ----

function fakeSock(): DirectorySocket & { fetches: number; metadataCalls: string[] } {
	const s = {
		fetches: 0,
		metadataCalls: [] as string[],
		async groupFetchAllParticipating() {
			s.fetches++
			return snapshot
		},
		async groupMetadata(jid: string) {
			s.metadataCalls.push(jid)
			return snapshot[jid]
		},
	}
	return s
}

test('directory: dentro do TTL não rebate na rede', async () => {
	const sock = fakeSock()
	let t = 1000
	const dir = createCommunityDirectory({ sock, ttlMs: 60_000, now: () => t })

	await dir.viewFor(GENERAL)
	await dir.viewFor(MARKETING)
	assert.equal(sock.fetches, 1)

	t += 60_001
	await dir.viewFor(GENERAL)
	assert.equal(sock.fetches, 2)
})

test('directory: invalidate força novo fetch', async () => {
	const sock = fakeSock()
	const dir = createCommunityDirectory({ sock, now: () => 1000 })
	await dir.viewFor(GENERAL)
	dir.invalidate()
	await dir.viewFor(GENERAL)
	assert.equal(sock.fetches, 2)
})

test('directory: rajada de comandos compartilha um único fetch em voo', async () => {
	const sock = fakeSock()
	const dir = createCommunityDirectory({ sock, now: () => 1000 })
	await Promise.all([dir.viewFor(GENERAL), dir.viewFor(MARKETING), dir.viewFor(MOD)])
	assert.equal(sock.fetches, 1)
})

test('directory: grupo ausente do snapshot força UM refresh e então desiste', async () => {
	const sock = fakeSock()
	const dir = createCommunityDirectory({ sock, now: () => 1000 })
	assert.equal(await dir.viewFor('999@g.us'), null)
	assert.equal(sock.fetches, 2)
})

test('directory: comunidade fora do participating é buscada por groupMetadata', async () => {
	const semPai = { ...snapshot }
	delete semPai[COMMUNITY]
	const sock: DirectorySocket & { metadataCalls: string[] } = {
		metadataCalls: [],
		async groupFetchAllParticipating() {
			return semPai
		},
		async groupMetadata(jid: string) {
			sock.metadataCalls.push(jid)
			return community
		},
	}
	const dir = createCommunityDirectory({ sock, now: () => 1000 })
	const view = await dir.viewFor(GENERAL)
	assert.deepEqual(sock.metadataCalls, [COMMUNITY])
	assert.equal(view?.scope, 'community')
	assert.equal(view?.admins.has(ADMIN_COM), true)
})

test('directory: groupMetadata do pai falhando degrada para escopo de grupo', async () => {
	const semPai = { ...snapshot }
	delete semPai[COMMUNITY]
	const sock: DirectorySocket = {
		async groupFetchAllParticipating() {
			return semPai
		},
		async groupMetadata() {
			throw new Error('403')
		},
	}
	const dir = createCommunityDirectory({ sock, now: () => 1000 })
	const view = await dir.viewFor(GENERAL)
	assert.equal(view?.scope, 'group')
})
