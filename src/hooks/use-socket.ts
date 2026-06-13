import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import fs from 'fs'
import path from 'path'
import makeWASocket, {
	CacheStore,
	DEFAULT_CONNECTION_CONFIG,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	WAMessageContent,
	WAMessageKey,
} from '@whiskeysockets/baileys'
import { useEffect, useMemo, useRef, useState } from 'react'
import { saveEvent } from '../event-logger.js'
import { loadGroupCache, saveGroupCache } from '../group-cache.js'
import { loadHistory } from '../history.js'
import { logger } from '../logger.js'
import { getMessage as getStoredMessage, storeMessage } from '../message-store.js'
import { buildOptionHashMap, decryptPollVote } from '../poll-decrypt.js'
import { startRetention } from '../retention.js'
import { createOutbox } from '../collector/outbox.js'
import { createEventRouter } from '../collector/event-router.js'
import { startWebhookSender } from '../collector/webhook-sender.js'
import { startHeartbeat } from '../collector/heartbeat.js'
import type { ChatEntry, ChatMessage, ConnectionStatus, DebugEvent, GroupInfo, MessageContent } from '../types.js'

const MAX_DEBUG_EVENTS = 200

function summarizeEvent(eventName: string, data: unknown): string {
	try {
		if (eventName === 'messages.upsert') {
			const d = data as { messages?: Array<{ pushName?: string; message?: Record<string, unknown> }> }
			const msg = d.messages?.[0]
			if (!msg) return ''
			const types = Object.keys(msg.message || {}).filter((k) => !['messageContextInfo', 'senderKeyDistributionMessage'].includes(k))
			return `${msg.pushName || '?'}: ${types[0] || 'unknown'}`
		}
		if (eventName === 'connection.update') {
			const d = data as Record<string, unknown>
			if (d.connection) return `${d.connection}`
			if (d.qr) return 'QR generated'
			if (d.isOnline) return 'online'
			return JSON.stringify(d).slice(0, 50)
		}
		if (eventName === 'presence.update') {
			const d = data as { id?: string; presences?: Record<string, { lastKnownPresence?: string }> }
			const who = Object.values(d.presences || {})[0]
			return `${who?.lastKnownPresence || '?'} in ${d.id?.split('@')[0] || '?'}`
		}
		if (eventName === 'messages.reaction') {
			const d = data as Array<{ reaction?: { text?: string } }>
			return d[0]?.reaction?.text || ''
		}
		if (eventName === 'chats.update') {
			const d = data as Array<{ id?: string }>
			return d[0]?.id?.split('@')[0] || ''
		}
		return ''
	} catch {
		return ''
	}
}

const msgRetryCounterCache = new NodeCache() as CacheStore

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

export function useSocket() {
	const history = useMemo(() => loadHistory(), [])
	const seenIds = useRef(new Set(history.messages.map((m) => m.id)))
	const [status, setStatus] = useState<ConnectionStatus>('disconnected')
	const [qrCode, setQrCode] = useState<string | null>(null)
	const [messages, setMessages] = useState<ChatMessage[]>(history.messages)
	const [chats, setChats] = useState<ChatEntry[]>(history.chats)
	const [me, setMe] = useState<string>('')
	const [pollResults, setPollResults] = useState<Record<string, Record<string, string[]>>>({})
	const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([])
	const [connectedAt, setConnectedAt] = useState<Date | null>(null)
	const sockRef = useRef<ReturnType<typeof makeWASocket> | null>(null)

	useEffect(() => {
		let stopped = false

		// última conexão conhecida — lida pelo heartbeat (o state `status` do React não é visível
		// dentro deste closure de efeito) e atualizada no handler de connection.update.
		let lastConnection = 'disconnected'

		const webhookUrl = process.env.WEBHOOK_URL
		const webhookSecret = process.env.WEBHOOK_SECRET
		const collectorOn = Boolean(webhookUrl && webhookSecret)
		const outbox = collectorOn ? createOutbox(path.resolve('outbox.db')) : null
		const router = outbox ? createEventRouter(outbox) : null
		const stopSender = outbox && webhookUrl && webhookSecret
			? startWebhookSender(outbox, {
				url: webhookUrl,
				secret: webhookSecret,
				onAlert: (kind, detail) => {
					// auth/dead-letter são acionáveis (segredo dessincronizado, payload rejeitado) → error;
					// overflow é aviso de fila crescendo → warn.
					if (kind === 'overflow') {
						logger.warn(detail, `coletor: outbox acima do limite`)
					} else {
						logger.error(detail, `coletor: alerta de envio (${kind})`)
					}
				},
			})
			: () => {}
		const stopHeartbeat = outbox
			? startHeartbeat({
				outbox,
				status: () => lastConnection,
				log: (stats) => logger.info(stats, 'coletor: heartbeat'),
			})
			: () => {}
		const stopRetention = startRetention((c) => logger.info(c, 'retention: arquivos podados'))

		async function connect() {
			const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')

			const { version } = await fetchLatestBaileysVersion()

			const sock = makeWASocket({
				version,
				logger,
				// `||` (not `??`) so an empty SOCKET_URL= in .env falls back to the default
				waWebSocketUrl: process.env.SOCKET_URL || DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, logger),
				},
				msgRetryCounterCache,
				generateHighQualityLinkPreview: true,
				getMessage: getStoredMessage,
			})

			sockRef.current = sock

			sock.ev.process(async (events) => {
				if (stopped) return

				for (const [eventName, eventData] of Object.entries(events)) {
					saveEvent(eventName, eventData)
					router?.handleEvent(eventName, eventData)
					setDebugEvents((prev) => {
						const entry: DebugEvent = { timestamp: new Date(), event: eventName, summary: summarizeEvent(eventName, eventData) }
						const next = [...prev, entry]
						return next.length > MAX_DEBUG_EVENTS ? next.slice(-MAX_DEBUG_EVENTS) : next
					})
				}

				if (events['connection.update']) {
					const update = events['connection.update']
					const { connection, lastDisconnect, qr } = update

					if (connection === 'connecting') {
						lastConnection = 'connecting'
						setStatus('connecting')
					}
					if (connection === 'open') {
						lastConnection = 'connected'
						setStatus('connected')
						setConnectedAt(new Date())
						setQrCode(null)
						if (sock.user) setMe(sock.user.name || sock.user.id)
						fetchGroupsMetadata(sock)
					}
					if (connection === 'close') {
						const code = (lastDisconnect?.error as Boom)?.output?.statusCode
						lastConnection = 'disconnected'
						// alerta de desconexão (ADR-0003 §10): sessão caiu; o sender segura os eventos no outbox.
						logger.warn({ code, willReconnect: !stopped && code !== DisconnectReason.loggedOut }, 'whatsapp: conexão caiu')
						if (stopped) return
						if (code === DisconnectReason.loggedOut) {
							// clear auth so next connect generates a fresh QR
							const authDir = path.resolve('baileys_auth_info')
							if (fs.existsSync(authDir)) {
								fs.rmSync(authDir, { recursive: true })
							}
						}
						setStatus('connecting')
						connect()
					}
					if (qr) {
						setStatus('qr')
						setQrCode(qr)
					}
				}

				if (events['creds.update']) {
					await saveCreds()
				}

				if (events['messages.upsert']) {
					const upsert = events['messages.upsert']
					if (upsert.type !== 'notify') return

					const newMsgs: ChatMessage[] = []
					for (const msg of upsert.messages) {
						const key = msg.key
						const msgId = key.id || crypto.randomUUID()

						if (msg.message) {
							storeMessage(key, msg.message)
						}

						if (seenIds.current.has(msgId)) continue
						seenIds.current.add(msgId)

						const msgObj = msg.message as unknown as Record<string, unknown> | undefined
						const stubType = (msg as unknown as Record<string, unknown>).messageStubType as number | undefined
						const stubParams = ((msg as unknown as Record<string, unknown>).messageStubParameters as string[]) || []

						let content: MessageContent
						if (stubType !== undefined && stubType !== null) {
							content = { type: 'stub', params: stubParams }
						} else if (msgObj) {
							content = parseContent(msgObj)

							// decrypt poll votes inline
							if (content.type === 'poll_vote' && msgObj.pollUpdateMessage) {
								const decrypted = await tryDecryptPollVote(msg)
								if (decrypted) {
									content = { ...content, selectedOptions: decrypted.selectedOptions }
									updatePollResults(decrypted.pollId, decrypted.selectedOptions, decrypted.allOptions, decrypted.voterJid)
								}
							}
						} else {
							content = { type: 'unknown' }
						}

						const ts = msg.messageTimestamp
						newMsgs.push({
							id: msgId,
							timestamp: ts ? new Date(Number(ts) * 1000) : new Date(),
							from: key.participant || key.participantAlt || key.remoteJid || '',
							fromMe: key.fromMe || false,
							pushName: msg.pushName || '',
							chat: key.remoteJid || '',
							chatType: key.remoteJid?.endsWith('@g.us') ? 'group' : 'dm',
							content,
						})
					}

					if (newMsgs.length > 0) {
						setMessages((prev) => [...prev, ...newMsgs])
					}
				}

				if (events['chats.update']) {
					const chatUpdates = events['chats.update'] as Array<Record<string, unknown>>
					setChats((prev) => {
						const map = new Map(prev.map((c) => [c.jid, c]))
						for (const chat of chatUpdates) {
							const jid = chat.id as string
							const existing = map.get(jid)
							const msgs = chat.messages as Array<Record<string, unknown>> | undefined
							const lastMsg = msgs?.[0] as Record<string, unknown> | undefined
							const innerMsg = lastMsg?.message as Record<string, unknown> | undefined

							let preview = existing?.lastMessage || ''
							if (innerMsg?.message) {
								const parsed = parseContent(innerMsg.message as Record<string, unknown>)
								preview = parsed.type === 'text' ? (parsed as { text: string }).text : `[${parsed.type}]`
							}

							map.set(jid, {
								jid,
								name: existing?.name || jid.split('@')[0],
								chatType: jid.endsWith('@g.us') ? 'group' : 'dm',
								lastMessage: preview,
								lastTimestamp: chat.conversationTimestamp
									? new Date(Number(chat.conversationTimestamp) * 1000)
									: existing?.lastTimestamp || new Date(),
								unreadCount: (chat.unreadCount as number) ?? existing?.unreadCount ?? 0,
							})
						}
						return Array.from(map.values()).sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime())
					})
				}
			})
		}

		async function tryDecryptPollVote(msg: { key: WAMessageKey; message?: proto.IMessage | null }) {
			const m = msg.message as unknown as Record<string, unknown>
			const pollUpdate = m.pollUpdateMessage as Record<string, unknown>
			const creationKey = pollUpdate?.pollCreationMessageKey as Record<string, unknown> | undefined
			if (!creationKey?.id) return null

			const pollId = creationKey.id as string
			const pollMsg = await getStoredMessage({ remoteJid: creationKey.remoteJid as string, id: pollId } as WAMessageKey)
			if (!pollMsg) return null

			const rawPoll = pollMsg as unknown as Record<string, unknown>
			const pollCreation = (rawPoll.pollCreationMessage || rawPoll.pollCreationMessageV3) as Record<string, unknown> | undefined
			const ctxInfo = rawPoll.messageContextInfo as Record<string, unknown> | undefined
			if (!pollCreation || !ctxInfo?.messageSecret) return null

			const vote = pollUpdate.vote as Record<string, unknown>
			if (!vote?.encPayload) return null

			const voterJid = (msg.key?.participant || msg.key?.remoteJid) as string
			const creatorJid = creationKey.participant as string
			const encKey = Buffer.from(ctxInfo.messageSecret as string, 'base64')
			const allOptions = ((pollCreation.options as Array<Record<string, unknown>>) || []).map((o) => (o.optionName as string) || '')

			try {
				const hashes = decryptPollVote(
					{ encPayload: vote.encPayload as string, encIv: vote.encIv as string },
					{ pollEncKey: encKey, pollCreatorJid: creatorJid, pollMsgId: pollId, voterJid },
				)
				const optionMap = buildOptionHashMap(allOptions)
				const selectedOptions = hashes.map((h) => optionMap[h] || h)
				return { pollId, selectedOptions, allOptions, voterJid }
			} catch {
				return null
			}
		}

		function updatePollResults(pollId: string, selectedOptions: string[], allOptions: string[], voterJid: string) {
			setPollResults((prev) => {
				const current = { ...(prev[pollId] || {}) }
				for (const opt of allOptions) {
					if (current[opt]) {
						current[opt] = current[opt].filter((v: string) => v !== voterJid)
					}
				}
				for (const opt of selectedOptions) {
					current[opt] = [...(current[opt] || []), voterJid]
				}
				return { ...prev, [pollId]: current }
			})
		}

		async function fetchGroupsMetadata(sock: ReturnType<typeof makeWASocket>) {
			const cache = loadGroupCache()

			setChats((prev) => {
				const groupJids = prev.filter((c) => c.chatType === 'group').map((c) => c.jid)

				// apply cached metadata immediately
				const updated = prev.map((c) => {
					if (c.chatType !== 'group') return c
					const cached = cache[c.jid]
					if (cached) return { ...c, name: cached.subject, groupInfo: cached }
					return c
				})

				// fetch fresh metadata in background for all groups
				for (const jid of groupJids) {
					sock.groupMetadata(jid).then((meta) => {
						const info: GroupInfo = {
							subject: meta.subject,
							desc: meta.desc || '',
							owner: meta.owner || '',
							size: meta.size || meta.participants.length,
							creation: meta.creation || 0,
							announce: meta.announce || false,
							isCommunity: meta.isCommunity || false,
							ephemeralDuration: meta.ephemeralDuration || 0,
							members: meta.participants.map((p) => ({
								jid: p.id,
								admin: p.admin || null,
							})),
						}

						cache[jid] = info
						saveGroupCache(cache)

						// envia o snapshot cru da metadata pro coletor (não vem como evento do socket)
						router?.handleEvent('groups.metadata', meta)

						setChats((prev) =>
							prev.map((c) =>
								c.jid === jid ? { ...c, name: info.subject, groupInfo: info } : c,
							),
						)
					}).catch(() => {})
				}

				return updated
			})
		}

		connect()

		return () => {
			stopped = true
			stopSender()
			stopHeartbeat()
			stopRetention()
			outbox?.close()
			sockRef.current?.end(undefined)
		}
	}, [])

	const sendMessage = async (jid: string, text: string) => {
		if (!sockRef.current) return
		await sockRef.current.sendMessage(jid, { text })
	}

	return { status, qrCode, messages, chats, me, pollResults, debugEvents, connectedAt, sendMessage }
}
