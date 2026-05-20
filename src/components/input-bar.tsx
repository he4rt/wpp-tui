import { Box, Text } from 'ink'
import { TextInput } from '@inkjs/ui'

interface InputBarProps {
	selectedChat: string | null
	onSubmit: (text: string) => void
}

export function InputBar({ selectedChat, onSubmit }: InputBarProps) {
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1} gap={1}>
			<Text bold color="gray">{'>'}</Text>
			<TextInput
				placeholder={selectedChat ? 'Type a message or /help' : 'Use ↑↓ to select a chat, /help for commands'}
				onSubmit={onSubmit}
			/>
		</Box>
	)
}
