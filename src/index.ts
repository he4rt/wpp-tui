import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, {
	CacheStore,
	DEFAULT_CONNECTION_CONFIG,
	DisconnectReason,
	fetchLatestBaileysVersion,
	generateMessageIDV2,
	getAggregateVotesInPollMessage,
	isJidNewsletter,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	WAMessageContent,
	WAMessageKey,
} from '@whiskeysockets/baileys'
import fs from 'fs'
import path from 'path'
import P from 'pino'
import qrcode from 'qrcode-terminal'

const LOGS_DIR = path.resolve('logs')

function saveEvent(eventName: string, data: unknown) {
	const sanitized = eventName.replace(/[^a-zA-Z0-9._-]/g, '_')
	const dir = path.join(LOGS_DIR, sanitized)
	fs.mkdirSync(dir, { recursive: true })

	const now = new Date()
	const date = now.toISOString().split('T')[0]
	const filePath = path.join(dir, `${date}.json`)

	const entry = {
		timestamp: now.toISOString(),
		data,
	}

	let entries: unknown[] = []
	if (fs.existsSync(filePath)) {
		entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
	}
	entries.push(entry)
	fs.writeFileSync(filePath, JSON.stringify(entries, null, 2))
}

const logger = P({
	level: 'trace',
	transport: {
		targets: [
			{
				target: 'pino-pretty',
				options: { colorize: true },
				level: 'trace',
			},
			{
				target: 'pino/file',
				options: { destination: './wa-logs.txt' },
				level: 'trace',
			},
		],
	},
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

const msgRetryCounterCache = new NodeCache() as CacheStore

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')

	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}

	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.debug({ version: version.join('.'), isLatest }, `using latest WA version`)

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		getMessage,
	})

	sock.ev.process(async (events) => {
		for (const [eventName, eventData] of Object.entries(events)) {
			saveEvent(eventName, eventData)
		}

		if (events['connection.update']) {
			const update = events['connection.update']
			const { connection, lastDisconnect, qr } = update

			if (connection === 'close') {
				if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
					startSock()
				} else {
					logger.fatal('Connection closed. You are logged out.')
				}
			}

			if (qr) {
				if (usePairingCode && !sock.authState.creds.registered) {
					const phoneNumber = await question('Please enter your phone number:\n')
					const code = await sock.requestPairingCode(phoneNumber)
					console.log(`Pairing code: ${code}`)
				} else {
					qrcode.generate(qr, { small: true })
				}
			}

			logger.debug(update, 'connection update')
		}

		if (events['creds.update']) {
			await saveCreds()
			logger.debug({}, 'creds save triggered')
		}

		if (events['labels.association']) {
			logger.debug(events['labels.association'], 'labels.association event fired')
		}

		if (events['labels.edit']) {
			logger.debug(events['labels.edit'], 'labels.edit event fired')
		}

		if (events['call']) {
			logger.debug(events['call'], 'call event fired')
		}

		if (events['messaging-history.set']) {
			const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
			if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
				logger.debug(messages, 'received on-demand history sync')
			}
			logger.debug(
				{
					contacts: contacts.length,
					chats: chats.length,
					messages: messages.length,
					isLatest,
					progress,
					syncType: syncType?.toString(),
				},
				'messaging-history.set event fired',
			)
		}

		if (events['messages.upsert']) {
			const upsert = events['messages.upsert']
			logger.debug(upsert, 'messages.upsert fired')

			if (!!upsert.requestId) {
				logger.debug(upsert, 'placeholder request message received')
			}

			if (upsert.type === 'notify') {
				for (const msg of upsert.messages) {
					if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
						const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text

						if (text === 'requestPlaceholder' && !upsert.requestId) {
							const messageId = await sock.requestPlaceholderResend(msg.key)
							logger.debug({ id: messageId }, 'requested placeholder resync')
						}

						if (text === 'onDemandHistSync') {
							const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
							logger.debug({ id: messageId }, 'requested on-demand history resync')
						}

						if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
							const id = generateMessageIDV2(sock.user?.id)
							logger.debug({ id, orig_id: msg.key.id }, 'replying to message')
							await sock.sendMessage(msg.key.remoteJid!, { text: 'pong ' + msg.key.id }, { messageId: id })
						}
					}
				}
			}
		}

		if (events['messages.update']) {
			logger.debug(events['messages.update'], 'messages.update fired')

			for (const { key, update } of events['messages.update']) {
				if (update.pollUpdates) {
					const pollCreation: proto.IMessage = {}
					if (pollCreation) {
						console.log(
							'got poll update, aggregation: ',
							getAggregateVotesInPollMessage({
								message: pollCreation,
								pollUpdates: update.pollUpdates,
							}),
						)
					}
				}
			}
		}

		if (events['message-receipt.update']) {
			logger.debug(events['message-receipt.update'])
		}

		if (events['contacts.upsert']) {
			logger.debug(events['contacts.upsert'])
		}

		if (events['messages.reaction']) {
			logger.debug(events['messages.reaction'])
		}

		if (events['presence.update']) {
			logger.debug(events['presence.update'])
		}

		if (events['chats.update']) {
			logger.debug(events['chats.update'])
		}

		if (events['contacts.update']) {
			for (const contact of events['contacts.update']) {
				if (typeof contact.imgUrl !== 'undefined') {
					const newUrl =
						contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
					logger.debug({ id: contact.id, newUrl }, `contact has a new profile pic`)
				}
			}
		}

		if (events['chats.delete']) {
			logger.debug({ deleted: events['chats.delete'] }, 'chats deleted')
		}

		if (events['group.member-tag.update']) {
			logger.debug({ update: events['group.member-tag.update'] }, 'group member tag update')
		}
	})

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()
