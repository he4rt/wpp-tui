import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget } from '../../src/collector/target-resolver.js'
import { normalizePhone, parseCommand } from '../../src/collector/command-core.js'
import { buildView } from '../../src/collector/community-directory.js'
import type { DirGroupMetadata } from '../../src/collector/community-directory.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const MARKETING = '120363000000000003@g.us'
const ADMIN = '100000000000001@lid'
const VITIMA = '100000000000004@lid'

const community: DirGroupMetadata = {
	id: COMMUNITY,
	subject: 'Comunidade Exemplo',
	isCommunity: true,
	participants: [{ id: ADMIN, admin: 'superadmin' }],
}
const snapshot: Record<string, DirGroupMetadata> = {
	[COMMUNITY]: community,
	[GENERAL]: { id: GENERAL, subject: 'Grupo Geral', linkedParent: COMMUNITY, participants: [{ id: ADMIN, admin: null }] },
	[MARKETING]: {
		id: MARKETING,
		subject: 'Marketing',
		linkedParent: COMMUNITY,
		participants: [{ id: VITIMA, phoneNumber: '5500900000001@s.whatsapp.net', admin: null }],
	},
}
const view = buildView(snapshot, GENERAL, community)!

const cmd = (text: string) => parseCommand(text)!
const textMsg = (text: string): CmdMessage => ({ message: { conversation: text } })
const replyMsg = (text: string, participant: string): CmdMessage => ({
	message: { extendedTextMessage: { text, contextInfo: { participant, stanzaId: 'S1' } } },
})
const mentionMsg = (text: string, ...mentionedJid: string[]): CmdMessage => ({
	message: { extendedTextMessage: { text, contextInfo: { mentionedJid } } },
})

// ---- normalizePhone ----

test('normalizePhone: aceita as formas que um moderador digita', () => {
	for (const raw of ['5500900000002', '+55 00 90000-0002', '+5500900000002', '(55) 00 90000 0002']) {
		assert.equal(normalizePhone(raw), '5500900000002', `falhou em: "${raw}"`)
	}
})

test('normalizePhone: aceita JID cru do Baileys', () => {
	assert.equal(normalizePhone('5500900000001@s.whatsapp.net'), '5500900000001')
	assert.equal(normalizePhone('5500900000001:12@s.whatsapp.net'), '5500900000001')
})

test('normalizePhone: rejeita o que não é número discável', () => {
	for (const raw of ['', '   ', 'spam', '123', '1234567890123456', '@Fulano', null, undefined]) {
		assert.equal(normalizePhone(raw), null, `deveria rejeitar: "${raw}"`)
	}
})

// ---- resolveTarget ----

test('resolveTarget: telefone acha alguém que está só em OUTRO subgrupo (o caso do log)', () => {
	const t = resolveTarget(textMsg('/ban 5500900000001'), cmd('/ban 5500900000001'), view)!
	assert.equal(t.via, 'phone')
	assert.equal(t.jid, VITIMA)
	assert.equal(t.phone, '5500900000001')
	assert.deepEqual(t.foundIn, [MARKETING])
})

test('resolveTarget: telefone formatado resolve igual', () => {
	const t = resolveTarget(textMsg('/ban +55 00 90000-0001'), cmd('/ban +55 00 90000-0001'), view)!
	assert.equal(t.jid, VITIMA)
	assert.equal(t.via, 'phone')
})

test('resolveTarget: motivo é o que sobra depois do telefone, com o case preservado', () => {
	const t = resolveTarget(textMsg('/ban 5500900000001 Spam De Cripto'), cmd('/ban 5500900000001 Spam De Cripto'), view)!
	assert.equal(t.reason, 'Spam De Cripto')
})

test('resolveTarget: telefone válido fora da comunidade vira pré-ban', () => {
	const t = resolveTarget(textMsg('/ban 5500900000009 furou fila'), cmd('/ban 5500900000009 furou fila'), view)!
	assert.equal(t.via, 'phone_pre_ban')
	assert.equal(t.jid, null)
	assert.equal(t.phone, '5500900000009')
	assert.deepEqual(t.foundIn, [])
	assert.equal(t.reason, 'furou fila')
})

test('resolveTarget: reply tem prioridade e traz os grupos do alvo', () => {
	const msg = replyMsg('/ban 5500900000009', VITIMA)
	const t = resolveTarget(msg, cmd('/ban 5500900000009'), view)!
	assert.equal(t.via, 'reply')
	assert.equal(t.jid, VITIMA)
	assert.deepEqual(t.foundIn, [MARKETING])
	assert.equal(t.phone, '5500900000001')
})

test('resolveTarget: no reply o motivo é o texto inteiro após o comando', () => {
	const t = resolveTarget(replyMsg('/ban link de golpe', VITIMA), cmd('/ban link de golpe'), view)!
	assert.equal(t.reason, 'link de golpe')
})

test('resolveTarget: menção resolve e o token @ não entra no motivo', () => {
	const t = resolveTarget(mentionMsg('/ban @5500900000001 flood', VITIMA), cmd('/ban @5500900000001 flood'), view)!
	assert.equal(t.via, 'mention')
	assert.equal(t.jid, VITIMA)
	assert.equal(t.reason, 'flood')
})

test('resolveTarget: reply de quem já saiu do escopo resolve sem grupos', () => {
	const t = resolveTarget(replyMsg('/ban', 'ninguem@lid'), cmd('/ban'), view)!
	assert.equal(t.jid, 'ninguem@lid')
	assert.deepEqual(t.foundIn, [])
	assert.equal(t.phone, null)
})

test('resolveTarget: sem reply, sem menção e sem telefone → null (o no_target de hoje)', () => {
	assert.equal(resolveTarget(textMsg('/ban'), cmd('/ban'), view), null)
	assert.equal(resolveTarget(textMsg('/ban @Fulano'), cmd('/ban @Fulano'), view), null)
	assert.equal(resolveTarget(textMsg('/ban 123'), cmd('/ban 123'), view), null)
})

test('resolveTarget: participant sem stanzaId não conta como reply', () => {
	const msg: CmdMessage = {
		message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: VITIMA } } },
	}
	assert.equal(resolveTarget(msg, cmd('/ban'), view), null)
})

test('resolveTarget: telefone multi-token não engole um motivo numérico', () => {
	const t = resolveTarget(textMsg('/ban 5500900000001 2024'), cmd('/ban 5500900000001 2024'), view)!
	assert.equal(t.jid, VITIMA)
	assert.equal(t.phone, '5500900000001')
	assert.equal(t.reason, '2024')
})

test('resolveTarget: telefone formatado com motivo depois', () => {
	const t = resolveTarget(textMsg('/ban +55 00 90000-0001 spam de cripto'), cmd('/ban +55 00 90000-0001 spam de cripto'), view)!
	assert.equal(t.jid, VITIMA)
	assert.equal(t.reason, 'spam de cripto')
})
