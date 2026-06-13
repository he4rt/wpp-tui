import fs from 'fs'
import path from 'path'

const LOGS_DIR = path.resolve('logs')
const STORE_DIR = path.resolve('logs', 'message-store')
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/
const DAY_MS = 86_400_000

// Apaga logs/<evento>/<YYYY-MM-DD>.json mais antigos que `days`. days <= 0 desativa.
// Usa a data do NOME do arquivo (não mtime) — robusto a cópias. logsDir é injetável p/ teste.
export function pruneOldEventLogs(days: number, now: Date = new Date(), logsDir: string = LOGS_DIR): number {
	if (!days || days <= 0 || !fs.existsSync(logsDir)) return 0
	const cutoff = now.getTime() - days * DAY_MS
	let removed = 0

	for (const entry of fs.readdirSync(logsDir, { withFileTypes: true })) {
		// só desce em subdiretórios de evento; ignora message-store (poda em pruneMessageStore)
		// e arquivos soltos na raiz (ex.: group-metadata.json — cache, não apagar)
		if (!entry.isDirectory() || entry.name === 'message-store') continue

		const dir = path.join(logsDir, entry.name)
		for (const file of fs.readdirSync(dir)) {
			const m = DATE_FILE.exec(file)
			if (!m) continue
			const fileDate = Date.parse(`${m[1]}T00:00:00Z`)
			if (Number.isFinite(fileDate) && fileDate < cutoff) {
				fs.rmSync(path.join(dir, file))
				removed++
			}
		}
	}
	return removed
}

// Apaga arquivos do message-store mais velhos que `days` (por mtime). days <= 0 desativa.
export function pruneMessageStore(days: number, now: Date = new Date(), storeDir: string = STORE_DIR): number {
	if (!days || days <= 0 || !fs.existsSync(storeDir)) return 0
	const cutoff = now.getTime() - days * DAY_MS
	let removed = 0

	for (const file of fs.readdirSync(storeDir)) {
		const fp = path.join(storeDir, file)
		try {
			if (fs.statSync(fp).mtimeMs < cutoff) {
				fs.rmSync(fp)
				removed++
			}
		} catch {
			// arquivo sumiu entre o readdir e o stat — ignora
		}
	}
	return removed
}

// Roda a poda na partida e 1x/dia. `log` é opcional (evita acoplar o pino aqui).
// Retorna função pra parar o timer.
export function startRetention(
	log?: (counts: { eventLogs: number; messageStore: number }) => void,
): () => void {
	const eventDays = Number(process.env.LOG_RETENTION_DAYS ?? 0)
	const storeDays = Number(process.env.MESSAGE_STORE_RETENTION_DAYS ?? 0)

	const run = () => {
		const eventLogs = pruneOldEventLogs(eventDays)
		const messageStore = pruneMessageStore(storeDays)
		if ((eventLogs || messageStore) && log) log({ eventLogs, messageStore })
	}

	run() // na partida
	const timer = setInterval(run, DAY_MS) // 1x/dia
	timer.unref?.()
	return () => clearInterval(timer)
}
