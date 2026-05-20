import P from 'pino'

export const logger = P({
	level: 'trace',
	transport: {
		target: 'pino/file',
		options: { destination: './wa-logs.txt' },
	},
})
logger.level = 'trace'
