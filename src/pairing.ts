import { Boom } from '@hapi/boom'
import fs from 'fs'
import path from 'path'
import P from 'pino'
import makeWASocketReal, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from '@whiskeysockets/baileys'

// Comando de pareamento one-shot (ADR-0003, supersede 0002). Estabelece a sessão de WhatsApp
// direto no server via pairing-code do Baileys — sem QR, sem TUI, sem Coletor. O operador roda
// `pnpm pair <numero>`, recebe um código de 8 caracteres no STDOUT, digita no celular (Aparelhos
// conectados > Conectar com número) e a sessão é gravada em baileys_auth_info/.
//
// Contrato de I/O: o STDOUT carrega SÓ o código (copiável); estado e logs vão para o STDERR.
// Tudo é injetável (socket/auth/relógio/timer/streams) para ser testável sem rede — ver
// tests/pairing.test.ts.

// Valida o número: apenas dígitos com DDI (ex.: 5511999999999). Rejeita `+`, `()`, `-`, espaços e
// qualquer coisa não numérica. Retorna o número normalizado (trim) ou null se inválido/ausente.
export function validatePairingNumber(raw: string | undefined): string | null {
	if (!raw) return null
	const trimmed = raw.trim()
	if (!/^[0-9]+$/.test(trimmed)) return null
	// sanity de comprimento E.164: DDI + número. Fora de 8..15 dígitos é quase certo um engano.
	if (trimmed.length < 8 || trimmed.length > 15) return null
	return trimmed
}

// Extrai o número e a flag --force do argv, com fallback do número por env (PAIR_NUMBER).
// O número vem do token seguinte a `--pair` (desde que não seja outra flag); se ausente, cai no env.
export function resolvePairingInput(
	argv: string[],
	env: NodeJS.ProcessEnv,
): { number: string | undefined; force: boolean } {
	const force = argv.includes('--force')
	const i = argv.indexOf('--pair')
	let number: string | undefined
	if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) number = argv[i + 1]
	if (!number) number = env.PAIR_NUMBER?.trim() || undefined
	return { number, force }
}

export interface PairingDeps {
	number: string | undefined // número cru (validado aqui dentro; inválido/ausente → exit 1, sem socket)
	force: boolean // re-pareia por cima de uma sessão registrada (descarta a atual)
	authDir?: string // padrão "baileys_auth_info" (o mesmo do serviço)
	logger: import('pino').Logger // logger de estado/erros (STDERR); o comando deriva component:'pairing'
	baileysLogger: import('pino').Logger // passado pro makeWASocket + key store
	makeSocket?: typeof makeWASocketReal // injetável p/ testes
	loadAuthState?: typeof useMultiFileAuthState // injetável p/ testes
	fetchVersion?: typeof fetchLatestBaileysVersion // injetável p/ testes (evita rede)
	writeCode?: (code: string) => void // padrão: escreve o código + \n no STDOUT
	timeoutMs?: number // padrão 120000; sem `open` até lá → exit 1
	setTimer?: (fn: () => void, ms: number) => { unref?: () => void } // injetável p/ testes
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	clearTimer?: (t: any) => void // injetável p/ testes
	rmAuthDir?: (dir: string) => void // padrão fs.rmSync recursivo; injetável p/ testes
}

// Executa o pareamento e resolve com o código de saída do processo (0 sucesso, != 0 falha).
// Não chama process.exit — quem chama (entrypoint) decide. Assim o teste apenas inspeciona o retorno.
export async function runPairing(deps: PairingDeps): Promise<number> {
	const log = deps.logger.child({ component: 'pairing' })

	// 1) Validação do número ANTES de tocar o socket (requisito: inválido/ausente não abre socket).
	const validNumber = validatePairingNumber(deps.number)
	if (!validNumber) {
		log.error(
			'pairing: número inválido ou ausente. Passe apenas dígitos com DDI — ex.: 5511999999999 — via `pnpm pair <numero>` ou a env PAIR_NUMBER.',
		)
		return 1
	}

	const authDir = path.resolve(deps.authDir ?? 'baileys_auth_info')
	const loadAuthState = deps.loadAuthState ?? useMultiFileAuthState
	const makeSocket = deps.makeSocket ?? makeWASocketReal
	const fetchVersion = deps.fetchVersion ?? fetchLatestBaileysVersion
	const writeCode = deps.writeCode ?? ((c: string) => void process.stdout.write(c + '\n'))
	const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
	const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
	const rmAuthDir =
		deps.rmAuthDir ??
		((dir: string) => {
			if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
		})
	const timeoutMs = deps.timeoutMs ?? 120_000

	// 2) Carrega o estado de auth do MESMO diretório do serviço. Isso só lê arquivos — nada de rede.
	let { state, saveCreds } = await loadAuthState(authDir)

	// 3) Sessão já registrada: recusa sem --force (não chama requestPairingCode). Com --force, descarta
	//    o diretório e recarrega — requestPairingCode exige creds NÃO registradas.
	if (state.creds.registered && !deps.force) {
		log.error(
			`pairing: já existe uma sessão registrada em ${authDir}. Use --force para re-parear (isso descarta a sessão atual).`,
		)
		return 1
	}
	if (state.creds.registered && deps.force) {
		log.warn(`pairing: --force com sessão existente; descartando ${authDir} e re-pareando.`)
		rmAuthDir(authDir)
		;({ state, saveCreds } = await loadAuthState(authDir))
	}

	const { version } = await fetchVersion()

	// 4) Conecta, solicita o pairing-code (só na 1ª vez) e aguarda `connection: 'open'` → grava creds
	//    → exit 0. Timeout (120s) → exit 1. Um `close` com `restartRequired` (515) é ESPERADO logo
	//    após o code ser aceito: reconecta sem re-solicitar o code (o mesmo padrão de core.ts). Qualquer
	//    outro `close` antes do open é falha → exit 1.
	return await new Promise<number>((resolve) => {
		let settled = false
		let requested = false
		let sock: ReturnType<typeof makeSocket> | null = null
		let timer: { unref?: () => void } | undefined

		const finish = (exitCode: number) => {
			if (settled) return
			settled = true
			if (timer) clearTimer(timer)
			sock?.end?.(undefined)
			resolve(exitCode)
		}

		async function connect() {
			if (settled) return

			const activeSock = makeSocket({
				version,
				logger: deps.baileysLogger,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, deps.baileysLogger),
				},
			})
			sock = activeSock

			// Solicita o code uma única vez (requestPairingCode exige creds NÃO registradas; após o
			// pareamento as creds ficam registradas e não se pede de novo no restart).
			if (!requested) {
				requested = true
				try {
					const code = await activeSock.requestPairingCode(validNumber as string)
					writeCode(code)
					log.info(
						`pairing: código gerado; digite no celular em Aparelhos conectados > Conectar com número. Aguardando pareamento (até ${Math.round(
							timeoutMs / 1000,
						)}s)…`,
					)
				} catch (err) {
					log.error({ err: String(err) }, 'pairing: falha ao solicitar o código de pareamento')
					finish(1)
					return
				}
			}

			activeSock.ev.process(async (events) => {
				if (settled) return
				if (events['creds.update']) await saveCreds()

				const update = events['connection.update']
				if (!update) return

				if (update.connection === 'open') {
					await saveCreds()
					log.info({ me: activeSock.user?.id }, `pairing: conectado; sessão gravada em ${authDir}.`)
					finish(0)
				}
				if (update.connection === 'close') {
					const code = (update.lastDisconnect?.error as Boom)?.output?.statusCode
					if (code === DisconnectReason.restartRequired) {
						// Esperado após o code ser aceito: recria o socket e segue aguardando o open.
						log.info('pairing: restart requerido pós-code; reconectando…')
						void connect()
						return
					}
					log.error(
						{ code, err: String(update.lastDisconnect?.error) },
						'pairing: conexão encerrada antes de o pareamento concluir.',
					)
					finish(1)
				}
			})
		}

		// connect() cria o socket de forma síncrona até o 1º await; só então armamos o timeout —
		// assim ele já encontra um socket vivo para encerrar (e o teste de timeout observa o end()).
		void connect()

		timer = setTimer(() => {
			log.error(
				`pairing: timeout aguardando o pareamento; nenhuma conexão aberta em ${Math.round(timeoutMs / 1000)}s.`,
			)
			finish(1)
		}, timeoutMs)
		timer.unref?.()
	})
}

// Ponte CLI: monta os deps reais (logger em STDERR, socket/auth reais) e retorna o exit code.
// O logger do pareamento escreve no STDERR (fd 2) para manter o STDOUT limpo (só o código).
export async function runPairingCli(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const { number, force } = resolvePairingInput(argv, env)

	const logger = P({ level: env.LOG_LEVEL || 'info' }, P.destination(2))
	const baileysLogger = logger.child({ component: 'baileys' }, { level: env.BAILEYS_LOG_LEVEL || 'warn' })

	return runPairing({ number, force, logger, baileysLogger })
}
