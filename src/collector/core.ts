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
import { createBanHandler } from './ban-command.js'
import { createKickHandler } from './kick-command.js'
import { createAdminHandler } from './admin-command.js'
import { createCommunityDirectory } from './community-directory.js'
import { resolveModerationConfig, type ModerationConfig } from './moderation-config.js'
import { createModerationReporter, createLogGroupPublisher } from './moderation-report.js'
import { createMessageLookup } from './message-lookup.js'
import { createDeletionWatcher } from './deletion-watcher.js'
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
	// grupos privados de admin (moderação e log). Omitido → resolvido do ambiente.
	moderation?: ModerationConfig
}

export interface CollectorCoreHandle {
	stop: () => Promise<void>
	sendMessage: (jid: string, text: string) => Promise<void> // usado SÓ pela TUI
}

const msgRetryCounterCache = new NodeCache() as CacheStore

// Teto da espera do stop() pelo connect() em voo. O connect() contém uma chamada HTTP
// (fetchLatestBaileysVersion) que numa rede ruim fica pendurada — e o stop() não pode ficar preso
// atrás dela, porque é depois dele que o outbox é fechado (checkpoint do WAL do SQLite). Sem este
// teto, um restart durante reconexão cairia no forceMs do shutdown (saída com código 1) sem nunca
// fechar o outbox. Em teste o connect() resolve em milissegundos: quem ganha a corrida é a promise.
const STOP_CONNECT_WAIT_MS = 2_000

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
	// aponta pro connect() em voo mais recente (inicial ou reconexão via 'close'). stop() espera essa
	// promise antes de terminar — sem isso, um connect() já passado dos awaits de auth/versão no
	// momento do stop() ainda abriria socket e registraria handlers depois que o chamador já
	// considerava o coletor parado (produção: reconecta ao WhatsApp mesmo "parado"; testes: o
	// connect() de um caso que já terminou seguia mexendo no mesmo authDir do caso seguinte).
	let connectPromise: Promise<void> = Promise.resolve()

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

		// stop() pode ter sido chamado enquanto ainda esperávamos o auth state / a versão mais
		// recente — sem este guard o connect() abandonado abriria socket e registraria ev.process
		// mesmo assim, "reconectando" depois que o coletor já era pra estar parado.
		if (stopped) return

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

		// diretório da comunidade: um snapshot por conexão, compartilhado pelos comandos que
		// precisam enxergar além do grupo onde foram digitados (quem está onde, quem é admin do topo).
		const directory = createCommunityDirectory({ sock: activeSock })

		// grupos privados de admin: onde não apagar o comando e para onde mandar o relatório.
		const moderationConfig = deps.moderation ?? resolveModerationConfig(process.env)
		const moderationLog = deps.logger.child({ component: 'moderation' })
		// nomes de grupo saem do cache que já alimenta a UI — sem chamada de rede. Usado tanto no
		// relatório do grupo de log quanto no journal, para as duas trilhas dizerem a mesma coisa.
		const groupName = (jid: string) => loadGroupCache()[jid]?.subject || jid
		const reporter = createModerationReporter({
			sock: activeSock,
			logGroupJid: moderationConfig.logGroupJid,
			groupName,
			onError: (err) => moderationLog.warn({ err: String(err) }, 'moderação: falha ao publicar no grupo de log'),
		})
		const visibility = { config: moderationConfig, deleter: activeSock, reporter, groupName }

		// apagamento de mensagem de terceiro (moderação sem comando): quem apagou, de quem era e o
		// que dizia. O conteúdo sai da trilha crua que o coletor já grava — o evento não o traz.
		const deletionWatcher = createDeletionWatcher({
			logger: deps.logger.child({ component: 'deletion' }),
			lookup: createMessageLookup(),
			groupName,
			// o bot apagando o comando de um moderador já é auditado como comando; não repetir aqui.
			self: () => [activeSock.user?.id, (activeSock.user as { lid?: string } | undefined)?.lid],
			publisher: createLogGroupPublisher({
				sock: activeSock,
				logGroupJid: moderationConfig.logGroupJid,
				onError: (err) => moderationLog.warn({ err: String(err) }, 'moderação: falha ao publicar apagamento no grupo de log'),
			}),
		})

		// handler do comando /ban — usa o socket ativo; silencioso, erros vão pro log de auditoria.
		const banHandler = createBanHandler({
			sock: activeSock,
			logger: deps.logger.child({ component: 'ban' }),
			directory,
			visibility,
		})

		// handler do comando /kick — mesma regra do /ban, alcance limitado ao grupo onde foi digitado.
		const kickHandler = createKickHandler({
			sock: activeSock,
			logger: deps.logger.child({ component: 'kick' }),
			directory,
			visibility,
		})

		// handler do comando /admin — usa o socket ativo; silencioso, erros vão pro log de auditoria.
		const adminHandler = createAdminHandler({
			sock: activeSock,
			logger: deps.logger.child({ component: 'admin' }),
			visibility,
		})

		activeSock.ev.process(async (events) => {
			if (stopped) return

			for (const [eventName, eventData] of Object.entries(events)) {
				// trilha NDJSON crua (ambos os modos preservam) + roteamento pro coletor + repasse pra UI.
				saveEvent(eventName, eventData)
				router?.handleEvent(eventName, eventData)
				deps.onEvent?.(eventName, eventData)
			}

			// entrada/saída de membro invalida o diretório: o próximo comando refaz o snapshot em vez
			// de decidir sobre uma lista de participantes vencida (o refetch é lazy — só na consulta).
			if (events['group-participants.update'] || events['groups.update']) {
				directory.invalidate()
			}

			// mensagem apagada por outra pessoa: registro de moderação sem comando.
			if (events['messages.update']) {
				void deletionWatcher.handle(events['messages.update'] as Parameters<typeof deletionWatcher.handle>[0])
			}

			// comandos de moderação: best-effort, não bloqueiam nem derrubam a coleta (handlers nunca lançam).
			if (events['messages.upsert']) {
				void banHandler.handle(events['messages.upsert'] as Parameters<typeof banHandler.handle>[0])
				void kickHandler.handle(events['messages.upsert'] as Parameters<typeof kickHandler.handle>[0])
				void adminHandler.handle(events['messages.upsert'] as Parameters<typeof adminHandler.handle>[0])
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
					connectPromise = connect()
				}
				if (qr) {
					deps.onQr?.(qr)
				}
			}
		})
	}

	connectPromise = connect()

	return {
		async stop() {
			stopped = true
			stopSender()
			stopHeartbeat()
			stopRetention()
			// espera o connect() em voo terminar (ou abortar pelo guard acima) antes de fechar outbox
			// e encerrar o socket — sem isso, stop() "concluía" enquanto uma conexão/reconexão ainda
			// em andamento seguia criando authDir/socket por trás. Com teto: ver STOP_CONNECT_WAIT_MS.
			await Promise.race([
				connectPromise.catch(() => {}),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, STOP_CONNECT_WAIT_MS)
					timer.unref?.()
				}),
			])
			outbox?.close()
			sock?.end(undefined)
		},
		async sendMessage(jid: string, text: string) {
			if (!sock) return
			await sock.sendMessage(jid, { text })
		},
	}
}
