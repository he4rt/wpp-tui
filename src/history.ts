import fs from 'fs'
import path from 'path'
import { loadGroupCache } from './group-cache.js'
import type { ChatEntry, ChatMessage, MessageContent } from './types.js'

const LOGS_DIR = path.resolve('logs')

export function parseLogContent(content: string): Array<{ timestamp: string; data: unknown }> {
	const trimmed = content.trim()
	if (!trimmed) return []
	// formato antigo: array JSON único
	if (trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed) as Array<{ timestamp: string; data: unknown }>
		} catch {
			// arquivo híbrido (array antigo + NDJSON novo) — cai pro parse por linha
		}
	}
	// formato NDJSON: 1 objeto por linha
	const out: Array<{ timestamp: string; data: unknown }> = []
	for (const line of trimmed.split('\n')) {
		const l = line.trim()
		if (!l) continue
		try {
			out.push(JSON.parse(l) as { timestamp: string; data: unknown })
		} catch {
			// linha parcial/corrompida — ignora
		}
	}
	return out
}

function readLogFiles(eventName: string): Array<{ timestamp: string; data: unknown }> {
	const dir = path.join(LOGS_DIR, eventName)
	if (!fs.existsSync(dir)) return []

	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
	const entries: Array<{ timestamp: string; data: unknown }> = []

	for (const file of files) {
		const content = fs.readFileSync(path.join(dir, file), 'utf-8')
		entries.push(...parseLogContent(content))
	}

	return entries
}

function parseContent(msg: Record<string, unknown>): MessageContent {
	if (!msg) return { type: 'unknown' }
	if (msg.conversation) return { type: 'text', text: msg.conversation as string }
	if (msg.extendedTextMessage) {
		const ext = msg.extendedTextMessage as Record<string, unknown>
		return { type: 'text', text: (ext.text as string) || '' }
	}
	if (msg.stickerMessage) {
		const stk = msg.stickerMessage as Record<string, unknown>
		return { type: 'sticker', animated: (stk.isAnimated as boolean) || false }
	}
	if (msg.imageMessage) {
		const img = msg.imageMessage as Record<string, unknown>
		return { type: 'image', caption: (img.caption as string) || '' }
	}
	if (msg.videoMessage) {
		const vid = msg.videoMessage as Record<string, unknown>
		return { type: 'video', caption: (vid.caption as string) || '', seconds: (vid.seconds as number) || 0 }
	}
	if (msg.audioMessage) {
		const aud = msg.audioMessage as Record<string, unknown>
		return { type: 'audio', seconds: (aud.seconds as number) || 0, ptt: (aud.ptt as boolean) || false }
	}
	if (msg.documentMessage) {
		const doc = msg.documentMessage as Record<string, unknown>
		return { type: 'document', filename: (doc.fileName as string) || '' }
	}
	if (msg.reactionMessage) {
		const react = msg.reactionMessage as Record<string, unknown>
		return { type: 'reaction', emoji: (react.text as string) || '' }
	}
	if (msg.locationMessage) {
		const loc = msg.locationMessage as Record<string, unknown>
		return { type: 'location', name: (loc.name as string) || '' }
	}
	if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
		const poll = (msg.pollCreationMessageV3 || msg.pollCreationMessage) as Record<string, unknown>
		const options = (poll.options as Array<Record<string, unknown>> || []).map((o) => (o.optionName as string) || '')
		return { type: 'poll', question: (poll.name as string) || '', options }
	}
	if (msg.pollUpdateMessage) {
		const update = msg.pollUpdateMessage as Record<string, unknown>
		const creationKey = update.pollCreationMessageKey as Record<string, unknown> | undefined
		return { type: 'poll_vote', pollId: (creationKey?.id as string) || '', selectedOptions: [] }
	}
	if (msg.protocolMessage) {
		const proto = msg.protocolMessage as Record<string, unknown>
		return { type: 'protocol', protocolType: (proto.type as string) || '' }
	}
	return { type: 'unknown' }
}

export function loadHistory(): { messages: ChatMessage[]; chats: ChatEntry[] } {
	const messages: ChatMessage[] = []
	const chatMap = new Map<string, ChatEntry>()
	const seen = new Set<string>()

	for (const entry of readLogFiles('messages.upsert')) {
		const data = entry.data as { messages?: Array<Record<string, unknown>>; type?: string }
		if (!data.messages) continue

		for (const msg of data.messages) {
			const key = msg.key as Record<string, unknown> | undefined
			if (!key) continue

			const msgId = key.id as string
			if (!msgId || seen.has(msgId)) continue
			seen.add(msgId)

			const remoteJid = (key.remoteJid as string) || ''
			const participant = (key.participant as string) || (key.participantAlt as string) || ''
			const fromMe = (key.fromMe as boolean) || false
			const pushName = (msg.pushName as string) || ''
			const msgTs = msg.messageTimestamp as number | string | undefined
			const stubType = msg.messageStubType as number | string | undefined
			const stubParams = (msg.messageStubParameters as string[]) || []
			const msgObj = msg.message as Record<string, unknown> | undefined

			let content: MessageContent
			if (stubType !== undefined && stubType !== null) {
				content = { type: 'stub', params: stubParams }
			} else if (msgObj) {
				content = parseContent(msgObj)
			} else {
				content = { type: 'unknown' }
			}

			messages.push({
				id: msgId,
				timestamp: msgTs ? new Date(Number(msgTs) * 1000) : new Date(entry.timestamp),
				from: participant || remoteJid,
				fromMe,
				pushName,
				chat: remoteJid,
				chatType: remoteJid.endsWith('@g.us') ? 'group' : 'dm',
				content,
			})

			if (remoteJid) {
				const existing = chatMap.get(remoteJid)
				const ts = msgTs ? new Date(Number(msgTs) * 1000) : new Date(entry.timestamp)
				const chatType = remoteJid.endsWith('@g.us') ? 'group' as const : 'dm' as const
				if (!existing || ts > existing.lastTimestamp) {
					chatMap.set(remoteJid, {
						jid: remoteJid,
						name: existing?.name || remoteJid.split('@')[0],
						chatType,
						lastMessage: content.type === 'text' ? (content as { text: string }).text : `[${content.type}]`,
						lastTimestamp: ts,
						unreadCount: 0,
					})
				}
			}
		}
	}

	// group names: cached metadata > groups.upsert > chats.upsert
	const groupCache = loadGroupCache()
	const groupNames = new Map<string, string>()
	for (const [jid, info] of Object.entries(groupCache)) {
		groupNames.set(jid, info.subject)
	}
	for (const source of ['groups.upsert', 'chats.upsert']) {
		for (const entry of readLogFiles(source)) {
			const items = Array.isArray(entry.data) ? entry.data : [entry.data]
			for (const item of items as Array<Record<string, unknown>>) {
				const jid = item.id as string
				const name = (item.subject as string) || (item.name as string)
				if (jid?.endsWith('@g.us') && name && !groupNames.has(jid)) {
					groupNames.set(jid, name)
				}
			}
		}
	}

	// DM names from pushNames in messages
	const dmNames = new Map<string, string>()
	for (const msg of messages) {
		if (msg.pushName && msg.chatType === 'dm' && !msg.fromMe) {
			dmNames.set(msg.chat, msg.pushName)
		}
	}

	// group member names as fallback
	const groupMembers = new Map<string, Set<string>>()
	for (const msg of messages) {
		if (msg.pushName && msg.chatType === 'group') {
			const members = groupMembers.get(msg.chat) ?? new Set()
			members.add(msg.pushName)
			groupMembers.set(msg.chat, members)
		}
	}

	// enrich chat names and attach groupInfo
	for (const chat of chatMap.values()) {
		if (chat.chatType === 'group') {
			const cached = groupCache[chat.jid]
			if (cached) chat.groupInfo = cached

			const name = groupNames.get(chat.jid)
			if (name) {
				chat.name = name
			} else {
				const members = groupMembers.get(chat.jid)
				if (members && members.size > 0) {
					const names = Array.from(members).slice(0, 3).join(', ')
					chat.name = members.size > 3 ? `${names}...` : names
				}
			}
		} else if (chat.chatType === 'dm') {
			const name = dmNames.get(chat.jid)
			if (name) chat.name = name
		}
	}

	messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
	const chats = Array.from(chatMap.values()).sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime())

	return { messages, chats }
}
