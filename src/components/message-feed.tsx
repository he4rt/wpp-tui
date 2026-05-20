import { Box, Text } from 'ink'
import type { ChatMessage, MessageContent } from '../types.js'

interface MessageFeedProps {
	messages: ChatMessage[]
	selectedChat: string | null
	chatName: string | null
	pollResults: Record<string, Record<string, string[]>>
	maxLines: number
	height: number
}

export function MessageFeed({ messages, selectedChat, chatName, pollResults, maxLines, height }: MessageFeedProps) {
	const filtered = selectedChat
		? messages.filter((m) => m.chat === selectedChat)
		: messages

	const visible = filtered.slice(-maxLines)

	return (
		<Box flexDirection="column" flexGrow={1} height={height} borderStyle="single" borderColor="blue" paddingX={1} overflow="hidden">
			<Text bold underline>
				MESSAGES{chatName ? ` — ${chatName}` : ' — all'}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{visible.length === 0 && <Text dimColor>No messages yet...</Text>}
				{visible.map((msg) => (
					<Box key={msg.id} flexDirection="column">
						<Box gap={1}>
							<Text dimColor>
								{msg.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
							</Text>
							<Text bold color={msg.fromMe ? 'green' : 'cyan'}>
								{(msg.pushName || 'unknown').padEnd(16).slice(0, 16)}
							</Text>
							<Text wrap="truncate">{formatContent(msg.content)}</Text>
						</Box>
						{msg.content.type === 'poll' && renderPollOptions(msg.id, msg.content, pollResults)}
					</Box>
				))}
			</Box>
		</Box>
	)
}

function renderPollOptions(msgId: string, content: { type: 'poll'; question: string; options: string[] }, pollResults: Record<string, Record<string, string[]>>) {
	const results = pollResults[msgId]

	const totalVotes = results
		? Object.values(results).reduce((sum, voters) => sum + voters.length, 0)
		: 0

	return (
		<Box flexDirection="column" marginLeft={7} marginBottom={1}>
			{content.options.map((opt) => {
				const count = results?.[opt]?.length ?? 0
				return (
					<Box key={opt} gap={1}>
						<Text dimColor>  {count > 0 ? '■' : '□'}</Text>
						<Text>{opt}</Text>
						{count > 0 && <Text color="green"> ({count})</Text>}
					</Box>
				)
			})}
			{totalVotes > 0 && (
				<Text dimColor>  {totalVotes} votes total</Text>
			)}
		</Box>
	)
}

function formatContent(content: MessageContent): string {
	switch (content.type) {
		case 'text':
			return content.text
		case 'sticker':
			return content.animated ? '🖼️ sticker (animated)' : '🖼️ sticker'
		case 'image':
			return content.caption ? `📷 ${content.caption}` : '📷 image'
		case 'video':
			return content.caption ? `🎬 ${content.caption}` : `🎬 video (${content.seconds}s)`
		case 'audio':
			return content.ptt ? `🎤 voice (${content.seconds}s)` : `🔊 audio (${content.seconds}s)`
		case 'document':
			return `📄 ${content.filename}`
		case 'reaction':
			return content.emoji
		case 'location':
			return content.name ? `📍 ${content.name}` : '📍 location'
		case 'poll':
			return `📊 ${content.question}`
		case 'poll_vote':
			return content.selectedOptions.length > 0
				? `🗳️ → ${content.selectedOptions.join(', ')}`
				: '🗳️ removed vote'
		case 'protocol':
			return `⚙️ ${content.protocolType}`
		case 'stub':
			return `⚠️ ${content.params[0] || 'system message'}`
		case 'unknown':
			return '?'
	}
}
