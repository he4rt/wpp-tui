import fs from 'fs'
import path from 'path'

const LOGS_DIR = path.resolve('logs')

export function saveEvent(eventName: string, data: unknown) {
	const sanitized = eventName.replace(/[^a-zA-Z0-9._-]/g, '_')
	const dir = path.join(LOGS_DIR, sanitized)
	fs.mkdirSync(dir, { recursive: true })

	const now = new Date()
	const date = now.toISOString().split('T')[0]
	const filePath = path.join(dir, `${date}.json`)

	const entry = {
		timestamp: now.toISOString(),
		event: eventName,
		data,
	}

	// NDJSON: append O(1), sem reler o arquivo (aguenta o volume de presence.update)
	fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')
}
