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
			text: '/ban 5500900000001 spam de cripto',
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
			'digitou: /ban 5500900000001 spam de cripto',
			'alvo: +55 00 90000-0001 · 100000000000004@lid',
			'identificado por: phone',
			'saiu de: Grupo Secundário',
			'alcance: comunidade Comunidade Exemplo',
			'motivo: spam de cripto',
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

test('resultado informativo usa ícone neutro', () => {
	assert.match(formatReport(entry({ result: 'no_target', fields: {} }), groupName), /^ℹ️ /)
	assert.match(formatReport(entry({ result: 'target_not_found', fields: {} }), groupName), /^ℹ️ /)
})

test('falha de infraestrutura usa ícone de alerta', () => {
	for (const result of ['delete_error', 'metadata_error', 'handler_error']) {
		assert.match(formatReport(entry({ result, fields: {} }), groupName), /^⚠️ /, result)
	}
})

test('comando não apagado não vira linha no relatório', () => {
	assert.doesNotMatch(formatReport(entry({ deleted: false, fields: {} }), groupName), /comando apagado/)
})

test('relatório do /admin diz o que o grupo virou, não só "applied"', () => {
	const text = formatReport(
		entry({ command: 'admin', result: 'applied', text: '/admin on', fields: { action: 'on', announceBefore: false, announceAfter: true } }),
		groupName,
	)
	assert.match(text, /^⚙️ \/admin · applied$/m)
	assert.match(text, /^somente admins falam: on \(off → on\)$/m)
})

test('relatório de tentativa sem alvo mostra o que foi digitado (é o que explica a recusa)', () => {
	const text = formatReport(entry({ result: 'no_target', text: '/ban fulano', fields: {} }), groupName)
	assert.match(text, /^digitou: \/ban fulano$/m)
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
