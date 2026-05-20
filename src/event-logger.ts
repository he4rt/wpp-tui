import fs from 'fs'
import path from 'path'

const LOGS_DIR = path.resolve('logs')
const WEBHOOK_URL = process.env.WEBHOOK_URL

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

	let entries: unknown[] = []
	if (fs.existsSync(filePath)) {
		entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
	}
	entries.push(entry)
	fs.writeFileSync(filePath, JSON.stringify(entries, null, 2))

	if (!WEBHOOK_URL) return

	fetch(WEBHOOK_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(entry),
	}).catch(() => {})
}
