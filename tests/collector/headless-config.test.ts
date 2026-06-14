import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHeadlessConfig, HeadlessConfigError } from '../../src/collector/headless-config.js'

// env mínima válida: clona um objeto-base para cada teste (nunca muta process.env).
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		WEBHOOK_URL: 'https://example.com/webhook',
		WHATSAPP_WEBHOOK_SECRET: 'super-secret',
		...extra,
	}
}

test('lança HeadlessConfigError quando WEBHOOK_URL está ausente', () => {
	const env = baseEnv({ WEBHOOK_URL: undefined })
	assert.throws(() => resolveHeadlessConfig(env), HeadlessConfigError)
})

test('lança HeadlessConfigError quando WEBHOOK_URL está vazia/em branco', () => {
	const env = baseEnv({ WEBHOOK_URL: '   ' })
	assert.throws(() => resolveHeadlessConfig(env), HeadlessConfigError)
})

test('lança HeadlessConfigError quando WHATSAPP_WEBHOOK_SECRET está ausente', () => {
	const env = baseEnv({ WHATSAPP_WEBHOOK_SECRET: undefined })
	assert.throws(() => resolveHeadlessConfig(env), HeadlessConfigError)
})

test('lança HeadlessConfigError quando WHATSAPP_WEBHOOK_SECRET está vazio/em branco', () => {
	const env = baseEnv({ WHATSAPP_WEBHOOK_SECRET: '   ' })
	assert.throws(() => resolveHeadlessConfig(env), HeadlessConfigError)
})

test('com URL e secret presentes retorna config com webhook populado', () => {
	const env = baseEnv()
	const cfg = resolveHeadlessConfig(env)
	assert.deepEqual(cfg.webhook, {
		url: 'https://example.com/webhook',
		secret: 'super-secret',
	})
	// defaults de caminhos
	assert.equal(cfg.authDir, 'baileys_auth_info')
	assert.equal(cfg.outboxPath, 'outbox.db')
})

test('webhook url/secret têm espaços aparados (trim)', () => {
	const env = baseEnv({
		WEBHOOK_URL: '  https://example.com/hook  ',
		WHATSAPP_WEBHOOK_SECRET: '  s3cr3t  ',
	})
	const cfg = resolveHeadlessConfig(env)
	assert.equal(cfg.webhook.url, 'https://example.com/hook')
	assert.equal(cfg.webhook.secret, 's3cr3t')
})

test('logger aplica defaults info/warn quando LOG_LEVEL/BAILEYS_LOG_LEVEL ausentes', () => {
	const cfg = resolveHeadlessConfig(baseEnv())
	assert.equal(cfg.logger.level, 'info')
	assert.equal(cfg.logger.baileysLevel, 'warn')
	assert.equal(cfg.logger.pretty, false)
	assert.equal(cfg.logger.file, null)
})

test('logger mapeia LOG_LEVEL/BAILEYS_LOG_LEVEL/LOG_PRETTY/WA_LOG_FILE', () => {
	const env = baseEnv({
		LOG_LEVEL: 'debug',
		BAILEYS_LOG_LEVEL: 'trace',
		LOG_PRETTY: '1',
		WA_LOG_FILE: '/var/log/wa.log',
	})
	const cfg = resolveHeadlessConfig(env)
	assert.equal(cfg.logger.level, 'debug')
	assert.equal(cfg.logger.baileysLevel, 'trace')
	assert.equal(cfg.logger.pretty, true)
	assert.equal(cfg.logger.file, '/var/log/wa.log')
})

test('LOG_PRETTY aceita variações verdadeiras (true/yes) case-insensitive', () => {
	for (const value of ['true', 'TRUE', 'yes', 'Yes', '1']) {
		const cfg = resolveHeadlessConfig(baseEnv({ LOG_PRETTY: value }))
		assert.equal(cfg.logger.pretty, true, `esperava pretty=true para LOG_PRETTY=${value}`)
	}
})

test('LOG_PRETTY com valores não verdadeiros mantém pretty=false', () => {
	for (const value of ['0', 'false', 'no', '', 'banana']) {
		const cfg = resolveHeadlessConfig(baseEnv({ LOG_PRETTY: value }))
		assert.equal(cfg.logger.pretty, false, `esperava pretty=false para LOG_PRETTY=${value}`)
	}
})

test('retentionWarning é true quando LOG_RETENTION_DAYS está ausente', () => {
	const cfg = resolveHeadlessConfig(baseEnv())
	assert.equal(cfg.retentionWarning, true)
})

test('retentionWarning é true quando LOG_RETENTION_DAYS é "0"', () => {
	const cfg = resolveHeadlessConfig(baseEnv({ LOG_RETENTION_DAYS: '0' }))
	assert.equal(cfg.retentionWarning, true)
})

test('retentionWarning é false quando LOG_RETENTION_DAYS é um número positivo', () => {
	const cfg = resolveHeadlessConfig(baseEnv({ LOG_RETENTION_DAYS: '7' }))
	assert.equal(cfg.retentionWarning, false)
})
