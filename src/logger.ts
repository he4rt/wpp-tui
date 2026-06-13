import P from 'pino'

// LOG_LEVEL controla o volume escrito em wa-logs.txt: 'info' em prod (default),
// 'trace' só em dev (loga cada frame do protocolo), 'silent' desliga o arquivo.
const level = process.env.LOG_LEVEL || 'info'

export const logger = P({
	level,
	transport: {
		target: 'pino/file',
		options: { destination: process.env.WA_LOG_FILE || './wa-logs.txt' },
	},
})
