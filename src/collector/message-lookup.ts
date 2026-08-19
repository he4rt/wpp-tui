// Recuperação do conteúdo de uma mensagem já apagada, a partir da trilha crua do coletor.
//
// Quando alguém apaga uma mensagem "para todos", o WhatsApp entrega apenas a CHAVE do que foi
// apagado — o conteúdo não vem no evento. Mas o coletor já grava todo `messages.upsert` em
// logs/messages.upsert/<dia>.json (NDJSON, uma linha por evento), então o texto original ainda
// está em disco: basta procurá-lo pelo id da mensagem.
//
// Busca do dia mais recente para trás, porque uma mensagem apagada é quase sempre recente. O custo
// é lido só quando um apagamento acontece — evento raro —, e o filtro por substring evita parsear
// as linhas que nem contêm o id procurado.

import fs from 'fs'
import path from 'path'
import readline from 'readline'

export interface LoggedMessage {
	text: string | null // texto da mensagem, quando era texto
	pushName: string | null // nome que o autor exibia na hora do envio
	sentAt: string | null // ISO de quando a mensagem foi enviada
	kind: string // 'conversation', 'imageMessage', 'audioMessage'… o que foi apagado
}

// Quantos dias para trás procurar. Três cobre "apagou no fim de semana" sem varrer meses de log.
const DEFAULT_DAYS = 3
const DIR = () => path.resolve('logs', 'messages.upsert')

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

// Texto de uma mensagem do Baileys, nas formas que o coletor registra.
function textOf(message: Record<string, any> | null | undefined): string | null {
	if (!message) return null
	if (typeof message.conversation === 'string') return message.conversation
	const ext = message.extendedTextMessage?.text
	if (typeof ext === 'string') return ext
	// mídia com legenda: a legenda é o que um humano reconhece da mensagem apagada.
	for (const key of ['imageMessage', 'videoMessage', 'documentMessage']) {
		const caption = message[key]?.caption
		if (typeof caption === 'string' && caption) return caption
	}
	return null
}

// Que tipo de mensagem era — para o relatório poder dizer "áudio apagado" em vez de nada.
function kindOf(message: Record<string, any> | null | undefined): string {
	if (!message) return 'desconhecido'
	const keys = Object.keys(message)
	return keys[0] ?? 'desconhecido'
}

function secondsToIso(ts: unknown): string | null {
	const n = typeof ts === 'number' ? ts : Number(ts)
	return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

// Procura o id num único arquivo NDJSON, linha a linha (os arquivos de um dia movimentado passam
// de dezenas de MB — carregar tudo em memória por causa de um apagamento seria desperdício).
async function scanFile(file: string, id: string): Promise<LoggedMessage | null> {
	if (!fs.existsSync(file)) return null
	const marca = `"${id}"` // pré-filtro barato: só parseia a linha que contém o id
	const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf-8'), crlfDelay: Infinity })
	let achado: LoggedMessage | null = null

	try {
		for await (const line of rl) {
			if (!line.includes(marca)) continue
			let entry: any
			try {
				entry = JSON.parse(line)
			} catch {
				continue // linha truncada (crash no meio de um append) não pode derrubar a busca
			}
			for (const msg of entry?.data?.messages ?? []) {
				if (msg?.key?.id !== id) continue
				achado = {
					text: textOf(msg.message),
					pushName: typeof msg.pushName === 'string' ? msg.pushName : null,
					sentAt: secondsToIso(msg.messageTimestamp),
					kind: kindOf(msg.message),
				}
				// a última ocorrência vence: retries do Baileys reenviam o mesmo id, e a versão
				// mais recente é a que o grupo viu.
			}
		}
	} finally {
		rl.close()
	}
	return achado
}

export interface MessageLookup {
	find(id: string): Promise<LoggedMessage | null>
}

// `days` = quantos dias de log varrer; `dir` e `now` são injetáveis p/ teste.
export function createMessageLookup(deps: { days?: number; dir?: string; now?: () => Date } = {}): MessageLookup {
	const days = deps.days ?? DEFAULT_DAYS
	const now = deps.now ?? (() => new Date())

	return {
		async find(id) {
			if (!id) return null
			const dir = deps.dir ?? DIR()
			const hoje = now()
			for (let i = 0; i < days; i++) {
				const dia = new Date(hoje.getTime() - i * 86_400_000)
				try {
					const achado = await scanFile(path.join(dir, `${isoDay(dia)}.json`), id)
					if (achado) return achado
				} catch {
					// log ilegível (permissão, arquivo removido no meio) não pode derrubar a coleta
				}
			}
			return null
		},
	}
}
