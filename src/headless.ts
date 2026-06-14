import { startCollectorCore } from './collector/core.js'
import { resolveHeadlessConfig, HeadlessConfigError } from './collector/headless-config.js'
import { installShutdown } from './collector/shutdown.js'
import { createLoggers } from './logging.js'

// Runner headless do coletor (ADR-0001/0002). Sem UI, sem Ink: resolve a config a partir do
// ambiente, monta os loggers, liga o núcleo do coletor e instala o shutdown gracioso.
// O headless EXIGE WEBHOOK_URL + WHATSAPP_WEBHOOK_SECRET (fail-fast antes de conectar) e NÃO
// mostra QR — se receber um QR (sem sessão válida), loga fatal e sai com código != 0 (ADR-0002).
export async function runHeadless(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	// Config primeiro (fail-fast). Se faltar env obrigatória, loga fatal e sai ANTES de conectar.
	let config
	try {
		config = resolveHeadlessConfig(env)
	} catch (err) {
		if (err instanceof HeadlessConfigError) {
			// Ainda não temos logger configurado; usa um logger mínimo em JSON pro stderr/stdout.
			const { app } = createLoggers({})
			app.child({ component: 'collector' }).fatal({ err: err.message }, 'headless: configuração inválida')
			process.exit(1)
		}
		throw err
	}

	const loggers = createLoggers(config.logger)
	const app = loggers.app
	const waLog = app.child({ component: 'whatsapp' })

	// Avisa quando a retenção não está configurada: os logs brutos NDJSON crescem sem limite.
	if (config.retentionWarning) {
		app.child({ component: 'retention' }).warn(
			'retention: LOG_RETENTION_DAYS ausente/0 — os logs brutos vão crescer sem limite. Defina LOG_RETENTION_DAYS para podar arquivos antigos.',
		)
	}

	const handle = startCollectorCore({
		authDir: config.authDir,
		outboxPath: config.outboxPath,
		logger: app,
		baileysLogger: loggers.baileys,
		webhook: config.webhook,
		onStatus: (status, info) => {
			// Ciclo de vida da conexão, sempre com component:whatsapp.
			if (status === 'connecting') {
				waLog.info('whatsapp: conectando')
			} else if (status === 'connected') {
				waLog.info({ me: info?.me }, 'whatsapp: conectado')
			} else if (status === 'disconnected') {
				waLog.warn('whatsapp: desconectado')
			} else {
				waLog.info({ status }, 'whatsapp: status')
			}
		},
		onQr: () => {
			// ADR-0002: headless não faz pareamento. QR aqui significa sessão ausente/inválida.
			waLog.fatal('whatsapp: sem sessão válida; pré-provisione baileys_auth_info (pareie na TUI e copie o diretório)')
			process.exit(1)
		},
		onEvent: (eventName) => {
			// Repasse opcional, apenas em debug (todo evento do baileys + "groups.metadata").
			waLog.debug({ event: eventName }, 'whatsapp: evento')
		},
	})

	installShutdown({
		stop: handle.stop,
		log: (event, detail) => {
			app.child({ component: 'collector' }).info({ event, detail }, 'headless: shutdown')
		},
		exit: process.exit,
	})
}
