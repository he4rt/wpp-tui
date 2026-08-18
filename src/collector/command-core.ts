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

export function isAdmin(p?: { admin?: 'admin' | 'superadmin' | null } | null): boolean {
	return p?.admin === 'admin' || p?.admin === 'superadmin'
}
