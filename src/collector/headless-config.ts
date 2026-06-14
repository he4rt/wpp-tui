import type { LoggerConfig } from '../logging.js'

// Erro de configuração do modo headless: lançado quando faltam variáveis obrigatórias.
// O entrypoint (headless.ts) captura, loga fatal e sai com código != 0 ANTES de conectar.
export class HeadlessConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'HeadlessConfigError'
	}
}

export interface HeadlessConfig {
	webhook: { url: string; secret: string }
	authDir: string
	outboxPath: string
	logger: LoggerConfig
	// true quando LOG_RETENTION_DAYS está ausente/0 → headless avisa sobre crescimento ilimitado de disco
	retentionWarning: boolean
}

// Interpreta valores "verdadeiros" de env como strings: "1", "true", "yes" (case-insensitive).
function truthy(value: string | undefined): boolean {
	if (!value) return false
	const normalized = value.trim().toLowerCase()
	return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

// Resolve a configuração do modo headless a partir do ambiente. Função pura: sem efeitos
// colaterais, sem logging. Lança HeadlessConfigError quando WEBHOOK_URL ou
// WHATSAPP_WEBHOOK_SECRET estão ausentes/vazios (fail-fast antes de conectar).
export function resolveHeadlessConfig(env: NodeJS.ProcessEnv): HeadlessConfig {
	const url = env.WEBHOOK_URL?.trim()
	const secret = env.WHATSAPP_WEBHOOK_SECRET?.trim()

	if (!url) {
		throw new HeadlessConfigError(
			'WEBHOOK_URL é obrigatória no modo headless. Defina a URL do webhook da plataforma antes de iniciar.',
		)
	}
	if (!secret) {
		throw new HeadlessConfigError(
			'WHATSAPP_WEBHOOK_SECRET é obrigatória no modo headless. Defina o segredo de assinatura do webhook antes de iniciar.',
		)
	}

	const logger: LoggerConfig = {
		level: env.LOG_LEVEL || 'info',
		baileysLevel: env.BAILEYS_LOG_LEVEL || 'warn',
		pretty: truthy(env.LOG_PRETTY),
		file: env.WA_LOG_FILE || null,
	}

	// retentionWarning quando a retenção não está configurada (ausente/0/NaN): nesse caso os
	// logs brutos NDJSON crescem sem limite e o operador deve ser avisado.
	const retentionDays = Number(env.LOG_RETENTION_DAYS ?? 0)
	const retentionWarning = !Number.isFinite(retentionDays) || retentionDays === 0

	return {
		webhook: { url, secret },
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger,
		retentionWarning,
	}
}
