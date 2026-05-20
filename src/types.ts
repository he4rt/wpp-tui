export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'qr'

export interface ChatMessage {
	id: string
	timestamp: Date
	from: string
	fromMe: boolean
	pushName: string
	chat: string
	chatType: 'group' | 'dm'
	content: MessageContent
}

export type MessageContent =
	| { type: 'text'; text: string }
	| { type: 'sticker'; animated: boolean }
	| { type: 'image'; caption: string }
	| { type: 'video'; caption: string; seconds: number }
	| { type: 'audio'; seconds: number; ptt: boolean }
	| { type: 'document'; filename: string }
	| { type: 'reaction'; emoji: string }
	| { type: 'location'; name: string }
	| { type: 'poll'; question: string; options: string[] }
	| { type: 'poll_vote'; pollId: string; selectedOptions: string[] }
	| { type: 'protocol'; protocolType: string }
	| { type: 'stub'; params: string[] }
	| { type: 'unknown' }

export interface PollResult {
	name: string
	voters: string[]
}

export interface GroupMember {
	jid: string
	admin: 'admin' | 'superadmin' | null
}

export interface GroupInfo {
	subject: string
	desc: string
	owner: string
	size: number
	creation: number
	announce: boolean
	isCommunity: boolean
	ephemeralDuration: number
	members: GroupMember[]
}

export interface ChatEntry {
	jid: string
	name: string
	chatType: 'group' | 'dm'
	lastMessage: string
	lastTimestamp: Date
	unreadCount: number
	groupInfo?: GroupInfo
}
