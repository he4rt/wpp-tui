import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import fs from 'fs'
import path from 'path'
import makeWASocketReal, {
	CacheStore,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import { saveEvent } from '../event-logger.js'
import { getMessage as getStoredMessage } from '../message-store.js'
import { saveGroupCache, loadGroupCache } from '../group-cache.js'
import { startRetention } from '../retention.js'
import { createOutbox } from './outbox.js'
import { createEventRouter } from './event-router.js'
import { startWebhookSender } from './webhook-sender.js'
import { startHeartbeat } from './heartbeat.js'
import type { ConnectionStatus, GroupInfo } from '../types.js'

// O núcleo do coletor: toda a lógica de conexão + coleta, sem nenhuma dependência de UI.
// É consumido tanto pela TUI (via use-socket.ts, que mapeia os callbacks pro state do React)
// quanto pelo runner headless (src/headless.ts). Fonte única da verdade (ADR-0001).

export interface CollectorCoreDeps {
	authDir: string // ex.: "baileys_auth_info"
	outboxPath: string // ex.: caminho resolvido de "outbox.db"
	logger: import('pino').Logger // logger da aplicação; o núcleo deriva filhos com tags de component
	baileysLogger: import('pino').Logger // passado pro makeWASocket + key store
	webhook: { url: string; secret: string } | null // coletor LIGADO somente se != null
	onStatus?: (status: ConnectionStatus, info?: { me?: string }) => void
	onQr?: (qr: string) => void
	onEvent?: (eventName: string, data: unknown) => void // disparado p/ TODO evento do baileys + o sintético "groups.metadata"
	makeSocket?: typeof makeWASocketReal // injetável p/ testes
	now?: () => number // injetável p/ testes
}

export interface CollectorCoreHandle {
	stop: () => Promise<void>
	sendMessage: (jid: string, text: string) => Promise<void> // usado SÓ pela TUI
}

const msgRetryCounterCache = new NodeCache() as CacheStore

// converte a metadata crua do baileys no shape persistido em cache (group-metadata.json).
function toGroupInfo(meta: import('@whiskeysockets/baileys').GroupMetadata): GroupInfo {
	return {
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
}

// reconstrói um shape compatível com GroupMetadata a partir do GroupInfo do cache.
// Usado pra emitir os nomes em cache IMEDIATAMENTE (feedback instantâneo na UI) antes de
// a chamada de rede do groupFetchAllParticipating terminar — o fetch fresco sobrescreve depois.
function toGroupMetadata(jid: string, info: GroupInfo): import('@whiskeysockets/baileys').GroupMetadata {
	return {
		id: jid,
		subject: info.subject,
		desc: info.desc,
		owner: info.owner,
		size: info.size,
		creation: info.creation,
		announce: info.announce,
		isCommunity: info.isCommunity,
		ephemeralDuration: info.ephemeralDuration,
		participants: info.members.map((m) => ({
			id: m.jid,
			admin: m.admin,
		})),
	} as import('@whiskeysockets/baileys').GroupMetadata
}

export function startCollectorCore(deps: CollectorCoreDeps): CollectorCoreHandle {
	const makeSocket = deps.makeSocket ?? makeWASocketReal
	const now = deps.now ?? Date.now
	const authDir = path.resolve(deps.authDir)

	// loggers filhos com tag de component (observabilidade — toda linha carrega o component).
	const waLog = deps.logger.child({ component: 'whatsapp' })
	const collectorLog = deps.logger.child({ component: 'collector' })
	const retentionLog = deps.logger.child({ component: 'retention' })

	const collectorOn = deps.webhook !== null
	const outbox = collectorOn ? createOutbox(path.resolve(deps.outboxPath)) : null
	const router = outbox ? createEventRouter(outbox) : null

	const stopSender = outbox && deps.webhook
		? startWebhookSender(outbox, {
			url: deps.webhook.url,
			secret: deps.webhook.secret,
			onAlert: (kind, detail) => {
				// auth/dead-letter são acionáveis (segredo dessincronizado, payload rejeitado) → error;
				// overflow é aviso de fila crescendo → warn.
				if (kind === 'overflow') {
					collectorLog.warn(detail, 'coletor: outbox acima do limite')
				} else {
					collectorLog.error(detail, `coletor: alerta de envio (${kind})`)
				}
			},
		})
		: () => {}

	// última conexão conhecida — lida pelo heartbeat (não há state de React aqui) e atualizada
	// no handler de connection.update.
	let lastConnection = 'disconnected'

	const stopHeartbeat = outbox
		? startHeartbeat({
			outbox,
			status: () => lastConnection,
			log: (stats) => collectorLog.info(stats, 'coletor: heartbeat'),
		})
		: () => {}

	const stopRetention = startRetention((c) => retentionLog.info(c, 'retention: arquivos podados'))

	let stopped = false
	let sock: ReturnType<typeof makeWASocketReal> | null = null

	async function fetchGroupsMetadata(activeSock: ReturnType<typeof makeWASocketReal>) {
		const cache = loadGroupCache()

		// passo 1 (cache-first): emite os nomes já conhecidos ANTES da rede, pra UI mostrar os
		// grupos na hora em vez de esperar o groupFetchAllParticipating (evita regressão de UX).
		for (const [jid, info] of Object.entries(cache)) {
			deps.onEvent?.('groups.metadata', toGroupMetadata(jid, info))
		}

		// fonte dos grupos: groupFetchAllParticipating (NÃO o state da UI) — o núcleo é UI-agnóstico.
		let participating: Record<string, import('@whiskeysockets/baileys').GroupMetadata>
		try {
			participating = await activeSock.groupFetchAllParticipating()
		} catch (err) {
			waLog.warn({ err: String(err) }, 'whatsapp: falha ao buscar metadata dos grupos')
			return
		}

		// passo 2 (refresh): metadata fresca sobrescreve o cache + a UI + alimenta o coletor.
		for (const meta of Object.values(participating)) {
			const info = toGroupInfo(meta)
			cache[meta.id] = info

			// envia o snapshot cru da metadata pro coletor (não vem como evento do socket)…
			router?.handleEvent('groups.metadata', meta)
			// …e pra UI (atualiza nomes de chat/groupInfo).
			deps.onEvent?.('groups.metadata', meta)
		}
		saveGroupCache(cache)
	}

	async function connect() {
		const { state, saveCreds } = await useMultiFileAuthState(authDir)

		const { version } = await fetchLatestBaileysVersion()

		const activeSock = makeSocket({
			version,
			logger: deps.baileysLogger,
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, deps.baileysLogger),
			},
			msgRetryCounterCache,
			generateHighQualityLinkPreview: true,
			// reenvio/retry do baileys recupera a mensagem pelo store em disco (no headless o store
			// fica vazio e retorna undefined, sem efeito — a decodificação de enquete é só-da-TUI).
			getMessage: getStoredMessage,
		})

		sock = activeSock

		activeSock.ev.process(async (events) => {
			if (stopped) return

			for (const [eventName, eventData] of Object.entries(events)) {
				// trilha NDJSON crua (ambos os modos preservam) + roteamento pro coletor + repasse pra UI.
				saveEvent(eventName, eventData)
				router?.handleEvent(eventName, eventData)
				deps.onEvent?.(eventName, eventData)
			}

			if (events['creds.update']) {
				await saveCreds()
			}

			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update

				if (connection === 'connecting') {
					lastConnection = 'connecting'
					deps.onStatus?.('connecting')
				}
				if (connection === 'open') {
					lastConnection = 'connected'
					const me = activeSock.user ? activeSock.user.name || activeSock.user.id : undefined
					deps.onStatus?.('connected', { me })
					fetchGroupsMetadata(activeSock)
				}
				if (connection === 'close') {
					const code = (lastDisconnect?.error as Boom)?.output?.statusCode
					lastConnection = 'disconnected'
					const willReconnect = !stopped && code !== DisconnectReason.loggedOut
					// alerta de desconexão (ADR-0003 §10): sessão caiu; o sender segura os eventos no outbox.
					waLog.warn({ code, willReconnect }, 'whatsapp: conexão caiu')
					if (stopped) return
					if (code === DisconnectReason.loggedOut) {
						// limpa a auth pra que o próximo connect gere uma nova sessão (QR).
						if (fs.existsSync(authDir)) {
							fs.rmSync(authDir, { recursive: true })
						}
					}
					deps.onStatus?.('connecting')
					connect()
				}
				if (qr) {
					deps.onQr?.(qr)
				}
			}
		})
	}

	connect()

	return {
		async stop() {
			stopped = true
			stopSender()
			stopHeartbeat()
			stopRetention()
			outbox?.close()
			sock?.end(undefined)
		},
		async sendMessage(jid: string, text: string) {
			if (!sock) return
			await sock.sendMessage(jid, { text })
		},
	}
}
