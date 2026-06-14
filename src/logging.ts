import P from 'pino'

// Dois loggers a partir de uma única config (ADR-0001/0002): o logger do app/coletor e o do Baileys.
// Puro: recebe a config pronta e devolve os loggers. Ler process.env é responsabilidade do CONFIG,
// não daqui — assim este módulo fica trivialmente testável.
export interface LoggerConfig {
	level?: string
	baileysLevel?: string
	pretty?: boolean
	file?: string | null
}

export interface Loggers {
	app: import('pino').Logger
	baileys: import('pino').Logger
}

// Escolhe o transporte compartilhado pelos dois loggers:
//   file não-vazio → pino/file para o destino (não escreve em stdout);
//   pretty         → pino-pretty no stdout (dev/headless legível);
//   default        → JSON no stdout (sem transport, escrita direta — ideal para coletor headless).
function buildTransport(cfg: LoggerConfig): P.TransportSingleOptions | undefined {
	if (cfg.file && cfg.file.length > 0) {
		return { target: 'pino/file', options: { destination: cfg.file } }
	}
	if (cfg.pretty) {
		return { target: 'pino-pretty', options: {} }
	}
	return undefined
}

export function createLoggers(cfg: LoggerConfig): Loggers {
	const transport = buildTransport(cfg)

	// O logger do app é a base; os chamadores derivam filhos com a tag `component`.
	const app = P({
		level: cfg.level ?? 'info',
		...(transport ? { transport } : {}),
	})

	// O logger do Baileys é separado (nível próprio, default 'warn') e já carrega component:'baileys'.
	// Vira filho do app para compartilhar o mesmo transporte/destino, mas com level independente.
	const baileys = app.child({ component: 'baileys' }, { level: cfg.baileysLevel ?? 'warn' })

	return { app, baileys }
}
