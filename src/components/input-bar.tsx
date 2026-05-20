import { Box, Text } from 'ink'
import { TextInput } from '@inkjs/ui'
import type { ActiveTab } from '../types.js'

interface InputBarProps {
	activeTab: ActiveTab
	selectedChat: string | null
	chatName: string | null
	onSubmit: (text: string) => void
}

const PLACEHOLDERS: Record<ActiveTab, string> = {
	chat: 'Type message or /help',
	stats: '/chat to go back, /help for commands',
	debug: '/chat to go back, ↑↓ to scroll',
}

export function InputBar({ activeTab, selectedChat, chatName, onSubmit }: InputBarProps) {
	const placeholder = activeTab === 'chat' && selectedChat
		? `Message ${chatName || 'chat'}... or /help`
		: PLACEHOLDERS[activeTab]

	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1} gap={1}>
			<Text bold color="gray">{'>'}</Text>
			<TextInput
				placeholder={placeholder}
				onSubmit={onSubmit}
			/>
		</Box>
	)
}
