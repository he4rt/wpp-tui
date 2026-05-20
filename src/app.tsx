import { Box, useApp, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { ChatList } from './components/chat-list.js'
import { Header } from './components/header.js'
import { InputBar } from './components/input-bar.js'
import { MessageFeed } from './components/message-feed.js'
import { QrView } from './components/qr-view.js'
import { useSocket } from './hooks/use-socket.js'

export function App() {
	const { columns, rows } = useWindowSize()
	const { status, qrCode, messages, chats, me, pollResults, sendMessage } = useSocket()
	const [selectedChat, setSelectedChat] = useState<string | null>(null)
	const { exit } = useApp()

	useInput((input, key) => {
		if (input === 'q' && key.ctrl) exit()

		if (key.upArrow || key.downArrow) {
			if (chats.length === 0) return
			const currentIdx = chats.findIndex((c) => c.jid === selectedChat)
			if (key.upArrow) {
				const next = currentIdx <= 0 ? chats.length - 1 : currentIdx - 1
				setSelectedChat(chats[next].jid)
			} else {
				const next = currentIdx >= chats.length - 1 ? 0 : currentIdx + 1
				setSelectedChat(chats[next].jid)
			}
		}
	})

	const handleSubmit = async (text: string) => {
		if (!text.trim()) return

		if (text === '/quit') {
			exit()
			return
		}

		if (selectedChat && !text.startsWith('/')) {
			await sendMessage(selectedChat, text)
		}
	}

	// header=3, input=3, borders=2
	const contentHeight = Math.max(rows - 8, 5)

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Header status={status} me={me} />

			{status === 'qr' && qrCode ? (
				<QrView qrCode={qrCode} />
			) : (
				<Box flexDirection="row" height={contentHeight}>
					<ChatList
						chats={chats}
						selectedChat={selectedChat}
						onSelect={setSelectedChat}
						maxItems={contentHeight - 3}
					/>
					<MessageFeed
						messages={messages}
						selectedChat={selectedChat}
						chatName={chats.find((c) => c.jid === selectedChat)?.name ?? null}
						pollResults={pollResults}
						maxLines={contentHeight - 3}
					/>
				</Box>
			)}

			<InputBar selectedChat={selectedChat} onSubmit={handleSubmit} />
		</Box>
	)
}
