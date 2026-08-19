// Primitivos compartilhados pelos comandos de moderação do coletor (/ban, /admin).
// Puros e sem dependência de rede — testáveis isoladamente.

// Shapes mínimos das mensagens do Baileys que os comandos precisam — mantidos locais para os
// testes usarem objetos simples. A WAMessage real do Baileys é estruturalmente compatível.
export interface CmdContextInfo {
	participant?: string | null // autor da msg citada (presente em replies)
	stanzaId?: string | null // id da msg citada (presente em replies)
	mentionedJid?: string[] | null // JIDs mencionados com @
}
export interface CmdMessageContent {
	conversation?: string | null
	extendedTextMessage?: { text?: string | null; contextInfo?: CmdContextInfo | null } | null
}
export interface CmdMessageKey {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
}
export interface CmdMessage {
	key?: CmdMessageKey | null
	message?: CmdMessageContent | null
	pushName?: string | null // nome que o autor exibe — usado no relatório de moderação
	// segundos UNIX de quando a mensagem foi enviada. O Baileys entrega number ou Long (protobuf);
	// só o toNumber() interessa aqui, então o shape mínimo aceita os dois.
	messageTimestamp?: number | { toNumber(): number } | null
}
export interface CmdParticipant {
	id: string
	admin?: 'admin' | 'superadmin' | null
}
export interface CmdUpsert {
	type: string
	messages: CmdMessage[]
}

// Texto da mensagem: conversation (texto puro) ou extendedTextMessage.text (reply/menção).
export function messageText(msg: CmdMessage): string {
	const m = msg.message
	if (!m) return ''
	if (typeof m.conversation === 'string') return m.conversation
	const ext = m.extendedTextMessage?.text
	return typeof ext === 'string' ? ext : ''
}

// Comando parseado: nome (sem prefixo, lowercase) + argumentos.
// `args` vem em lowercase (comparação de flags, ex.: /admin on|off); `rawArgs` preserva o texto
// como foi digitado — o motivo do ban ("Spam De Cripto") não pode ser achatado pela normalização.
export interface ParsedCommand {
	name: string
	args: string[]
	rawArgs: string[]
}

// Detecta o comando pelo PRIMEIRO token, com prefixo "/" OU "!" (case-insensitive).
// Por token, não match exato: na menção o texto vem como "/ban @Fulano".
export function parseCommand(text: string): ParsedCommand | null {
	const tokens = text.trim().split(/\s+/).filter(Boolean)
	const m = /^[/!](\w+)$/.exec(tokens[0] ?? '')
	if (!m) return null
	const rawArgs = tokens.slice(1)
	return { name: m[1].toLowerCase(), args: rawArgs.map((t) => t.toLowerCase()), rawArgs }
}

// Quando o comando foi DIGITADO, em ISO — não quando o log foi escrito. Os dois divergem em
// reconexão (o lote chega atrasado), e é essa diferença que explica um comando que "não funcionou
// na hora". null quando a mensagem não trouxe timestamp utilizável.
export function sentAtIso(msg: CmdMessage): string | null {
	const ts = msg.messageTimestamp
	if (ts === null || ts === undefined) return null
	const seconds = typeof ts === 'number' ? ts : typeof ts.toNumber === 'function' ? ts.toNumber() : NaN
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return new Date(seconds * 1000).toISOString()
}

export function isAdmin(p?: { admin?: 'admin' | 'superadmin' | null } | null): boolean {
	return p?.admin === 'admin' || p?.admin === 'superadmin'
}

// Telefone em dígitos puros, ou null se não parecer um número discável.
// Aceita as formas que um moderador digita ("+55 00 90000-0002", "(11) 99999-9999") e também o
// JID cru do Baileys ("5500900000002@s.whatsapp.net"), de onde o phoneNumber dos participantes vem.
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null
	const digits = raw.split('@')[0].split(':')[0].replace(/\D/g, '')
	// 8 dígitos cobre número local curto; 15 é o teto do E.164.
	return digits.length >= 8 && digits.length <= 15 ? digits : null
}
