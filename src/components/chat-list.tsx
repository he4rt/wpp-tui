import { Box, Text } from 'ink'
import type { ChatEntry } from '../types.js'

interface ChatListProps {
	chats: ChatEntry[]
	selectedChat: string | null
	onSelect: (jid: string) => void
	maxItems: number
}

export function ChatList({ chats, selectedChat, maxItems }: ChatListProps) {
	const selectedIdx = chats.findIndex((c) => c.jid === selectedChat)

	let start = 0
	if (selectedIdx > maxItems - 2) {
		start = Math.min(selectedIdx - Math.floor(maxItems / 2), chats.length - maxItems)
		start = Math.max(start, 0)
	}
	const visible = chats.slice(start, start + maxItems)

	return (
		<Box flexDirection="column" width={30} borderStyle="single" borderColor="gray" paddingX={1}>
			<Text bold underline>CHATS</Text>
			<Box flexDirection="column" marginTop={1}>
				{visible.length === 0 && <Text dimColor>No chats yet...</Text>}
				{visible.map((chat) => {
					const isSelected = chat.jid === selectedChat
					const icon = chat.chatType === 'group' ? '#' : '@'
					const name = truncate(chat.name, 22)
					const size = chat.groupInfo?.size
					return (
						<Box key={chat.jid}>
							<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
								{isSelected ? '>' : ' '} <Text color={chat.chatType === 'group' ? 'yellow' : 'magenta'}>{icon}</Text> {name}
							</Text>
							{size && <Text dimColor> ({size})</Text>}
							{chat.unreadCount > 0 && (
								<Text color="green" bold> {chat.unreadCount}</Text>
							)}
						</Box>
					)
				})}
			</Box>
			{chats.length > maxItems && (
				<Box marginTop={1}>
					<Text dimColor>{chats.length} chats</Text>
				</Box>
			)}
		</Box>
	)
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str
	return str.slice(0, max - 2) + '..'
}
