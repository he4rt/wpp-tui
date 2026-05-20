import fs from 'fs'
import path from 'path'
import { proto, WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys'

const STORE_DIR = path.resolve('logs', 'message-store')

function keyToFilename(key: WAMessageKey): string {
	const chat = (key.remoteJid || '').replace(/[^a-zA-Z0-9]/g, '_')
	return `${chat}_${key.id}.json`
}

export function storeMessage(key: WAMessageKey, message: proto.IMessage) {
	fs.mkdirSync(STORE_DIR, { recursive: true })
	const filePath = path.join(STORE_DIR, keyToFilename(key))
	fs.writeFileSync(filePath, JSON.stringify(message))
}

export async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
	const filePath = path.join(STORE_DIR, keyToFilename(key))
	if (!fs.existsSync(filePath)) return undefined
	const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
	return proto.Message.fromObject(raw)
}
