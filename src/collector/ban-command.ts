// Comando de moderação /ban: parse do comando, resolução do alvo e execução da remoção.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.

// Shapes mínimos das mensagens do Baileys que o comando precisa — mantidos locais para os testes
// usarem objetos simples. A WAMessage real do Baileys é estruturalmente compatível.
export interface BanContextInfo {
	participant?: string | null // autor da msg citada (presente em replies)
	stanzaId?: string | null // id da msg citada (presente em replies)
	mentionedJid?: string[] | null // JIDs mencionados com @
}
export interface BanMessageContent {
	conversation?: string | null
	extendedTextMessage?: { text?: string | null; contextInfo?: BanContextInfo | null } | null
}
export interface BanMessageKey {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
}
export interface BanMessage {
	key?: BanMessageKey | null
	message?: BanMessageContent | null
}

// Texto da mensagem: conversation (texto puro) ou extendedTextMessage.text (reply/menção).
export function messageText(msg: BanMessage): string {
	const m = msg.message
	if (!m) return ''
	if (typeof m.conversation === 'string') return m.conversation
	const ext = m.extendedTextMessage?.text
	return typeof ext === 'string' ? ext : ''
}

// Detecta o comando pelo PRIMEIRO token (case-insensitive). Por token, não match exato,
// porque na menção o texto vem como "/ban @Fulano".
export function parseBanCommand(text: string): boolean {
	const first = text.trim().split(/\s+/)[0]
	return first?.toLowerCase() === '/ban'
}
