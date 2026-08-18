import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReport, prettyPhone, createModerationReporter } from '../../src/collector/moderation-report.js'
import type { ReportEntry, ReportSocket } from '../../src/collector/moderation-report.js'

const COMMUNITY = '120363000000000001@g.us'
const GENERAL = '120363000000000002@g.us'
const MARKETING = '120363000000000003@g.us'
const LOG = '120363000000000006@g.us'

const NAMES: Record<string, string> = {
	[COMMUNITY]: 'Comunidade Exemplo',
	[GENERAL]: 'Grupo Geral',
	[MARKETING]: 'Grupo Secundário',
}
const groupName = (jid: string) => NAMES[jid] ?? jid

const entry = (over: Partial<ReportEntry> = {}): ReportEntry => ({
	command: 'ban',
	result: 'removed',
	group: GENERAL,
	actor: '100000000000001@lid',
	actorName: 'Clinton',
	deleted: true,
	fields: {},
	...over,
})

test('prettyPhone: formata o que dá, devolve o resto com +', () => {
	assert.equal(prettyPhone('5500900000001'), '+55 00 90000-0001')
	assert.equal(prettyPhone('550090000001'), '+55 00 9000-0001')
	assert.equal(prettyPhone('123'), '+123')
	assert.equal(prettyPhone(null), null)
	assert.equal(prettyPhone(42), null)
})

test('relatório de ban executado traz tudo que o moderador precisa', () => {
	const text = formatReport(
		entry({
			fields: {
				target: '100000000000004@lid',
				phone: '5500900000001',
				via: 'phone',
				scope: 'community',
				community: COMMUNITY,
				reach: 'community',
				removedFrom: [MARKETING],
				reason: 'spam de cripto',
				status: '200',
				denylisted: true,
			},
		}),
		groupName,
	)

	assert.equal(
		text,
		[
			'🔨 /ban · removed',
			'grupo: Grupo Geral',
			'por: Clinton · 100000000000001@lid',
			'alvo: +55 00 90000-0001 · 100000000000004@lid',
			'identificado por: phone',
			'saiu de: Grupo Secundário',
			'alcance: comunidade Comunidade Exemplo',
			'motivo: spam de cripto',
			'denylist: registrado',
			'comando apagado ✓',
		].join('\n'),
	)
})

test('relatório de tentativa negada explica quem tentou o quê', () => {
	const text = formatReport(
		entry({ result: 'not_authorized', actorName: null, fields: { target: null, phone: '5500900000001', scope: 'community' } }),
		groupName,
	)
	assert.match(text, /^🚫 \/ban · not_authorized$/m)
	assert.match(text, /^por: 100000000000001@lid$/m)
	assert.match(text, /^alvo: \+55 00 90000-0001$/m)
	assert.match(text, /^comando apagado ✓$/m)
})

test('status != 200 aparece com a explicação do 403', () => {
	const text = formatReport(entry({ result: 'remove_rejected', fields: { status: '403', target: 'x@lid' } }), groupName)
	assert.match(text, /^⚠️ \/ban · remove_rejected$/m)
	assert.match(text, /resposta do WhatsApp: 403 \(o bot não é admin da comunidade\)/)
})

test('relatório do /kick deixa claro que o alcance foi só o grupo', () => {
	const text = formatReport(
		entry({ command: 'kick', fields: { target: 'x@lid', reach: 'group', removedFrom: [GENERAL] } }),
		groupName,
	)
	assert.match(text, /^alcance: só este grupo$/m)
	assert.match(text, /^saiu de: Grupo Geral$/m)
})

test('relatório do /unban mostra o ban que está sendo desfeito', () => {
	const text = formatReport(
		entry({
			command: 'unban',
			result: 'unbanned',
			fields: { phone: '5500900000001', bannedBy: 'chefe@lid', bannedAt: '2026-08-18T13:17:59.895Z', bannedReason: 'spam' },
		}),
		groupName,
	)
	assert.match(text, /^🔓 \/unban · unbanned$/m)
	assert.match(text, /ban original: chefe@lid em 2026-08-18T13:17:59.895Z — spam/)
})

test('relatório de reentrada mostra quem adicionou', () => {
	const text = formatReport(
		entry({ command: 'denylist', result: 'enforced', deleted: false, fields: { target: 'x@lid', addedBy: 'admin@lid', reach: 'community', community: COMMUNITY } }),
		groupName,
	)
	assert.match(text, /^🔁 \/denylist · enforced$/m)
	assert.match(text, /^adicionado por: admin@lid$/m)
	assert.doesNotMatch(text, /comando apagado/)
})

test('resultado informativo usa ícone neutro', () => {
	assert.match(formatReport(entry({ result: 'no_target', fields: {} }), groupName), /^ℹ️ /)
	assert.match(formatReport(entry({ result: 'pre_banned', fields: {} }), groupName), /^🪤 /)
})

test('JID de grupo sem nome conhecido aparece cru', () => {
	assert.match(formatReport(entry({ group: '000@g.us', fields: {} }), groupName), /^grupo: 000@g\.us$/m)
})

// ---- publish ----

function fakeSock() {
	const sent: Array<{ jid: string; text: string }> = []
	const sock: ReportSocket = {
		async sendMessage(jid, content) {
			sent.push({ jid, text: content.text })
			return {}
		},
	}
	return { sock, sent }
}

test('publish manda para o grupo de log', async () => {
	const { sock, sent } = fakeSock()
	const reporter = createModerationReporter({ sock, logGroupJid: LOG, groupName })
	await reporter.publish(entry({ fields: { target: 'x@lid' } }))

	assert.equal(sent.length, 1)
	assert.equal(sent[0].jid, LOG)
	assert.match(sent[0].text, /^🔨 \/ban · removed$/m)
})

test('sem LOG_GROUP_JID o publish é no-op (o journal segue completo)', async () => {
	const { sock, sent } = fakeSock()
	const reporter = createModerationReporter({ sock, logGroupJid: null, groupName })
	await reporter.publish(entry())
	assert.deepEqual(sent, [])
})

test('falha ao publicar é reportada e não propaga', async () => {
	const errors: unknown[] = []
	const sock: ReportSocket = {
		async sendMessage() {
			throw new Error('sem conexão')
		},
	}
	const reporter = createModerationReporter({ sock, logGroupJid: LOG, onError: (e) => errors.push(e) })
	await reporter.publish(entry())
	assert.equal(errors.length, 1)
})
