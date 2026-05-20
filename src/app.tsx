import { Box, useApp, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { ChatList } from './components/chat-list.js'
import { DebugView } from './components/debug-view.js'
import { Header } from './components/header.js'
import { InputBar } from './components/input-bar.js'
import { MessageFeed } from './components/message-feed.js'
import { QrView } from './components/qr-view.js'
import { StatsView } from './components/stats-view.js'
import { useSocket } from './hooks/use-socket.js'
import type { ActiveTab } from './types.js'

export function App() {
	const { columns, rows } = useWindowSize()
	const { status, qrCode, messages, chats, me, pollResults, debugEvents, connectedAt, sendMessage } = useSocket()
	const [activeTab, setActiveTab] = useState<ActiveTab>('chat')
	const [selectedChat, setSelectedChat] = useState<string | null>(null)
	const [debugScroll, setDebugScroll] = useState(0)
	const { exit } = useApp()

	// header=3, input=3
	const contentHeight = Math.max(rows - 6, 5)

	useInput((input, key) => {
		if (input === 'q' && key.ctrl) exit()

		if (key.tab) {
			setActiveTab((prev) => {
				if (prev === 'chat') return 'stats'
				if (prev === 'stats') return 'debug'
				return 'chat'
			})
			setDebugScroll(0)
			return
		}

		if (activeTab === 'chat') {
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
		}

		if (activeTab === 'debug') {
			if (key.upArrow) setDebugScroll((prev) => Math.min(prev + 3, Math.max(0, debugEvents.length - 5)))
			if (key.downArrow) setDebugScroll((prev) => Math.max(0, prev - 3))
		}
	})

	const handleSubmit = (text: string) => {
		if (!text.trim()) return

		// commands work in any tab
		if (text === '/quit' || text === '/q') { exit(); return }
		if (text === '/chat' || text === '/1') { setActiveTab('chat'); return }
		if (text === '/stats' || text === '/2') { setActiveTab('stats'); return }
		if (text === '/debug' || text === '/3') { setActiveTab('debug'); return }
		if (text === '/help') return

		if (activeTab === 'chat' && selectedChat && !text.startsWith('/')) {
			sendMessage(selectedChat, text)
		}
	}

	const chatName = chats.find((c) => c.jid === selectedChat)?.name ?? null

	return (
		<Box flexDirection="column" width={columns} height={rows}>
			<Header status={status} me={me} activeTab={activeTab} />

			{status === 'qr' && qrCode ? (
				<QrView qrCode={qrCode} />
			) : (
				<>
					{activeTab === 'chat' && (
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
								chatName={chatName}
								pollResults={pollResults}
								maxLines={contentHeight - 3}
								height={contentHeight}
							/>
						</Box>
					)}

					{activeTab === 'stats' && (
						<StatsView
							messages={messages}
							chats={chats}
							height={contentHeight}
						/>
					)}

					{activeTab === 'debug' && (
						<DebugView
							events={debugEvents}
							status={status}
							connectedAt={connectedAt}
							messageCount={messages.length}
							chatCount={chats.length}
							height={contentHeight}
							scrollOffset={debugScroll}
						/>
					)}
				</>
			)}

			<InputBar
				activeTab={activeTab}
				selectedChat={selectedChat}
				chatName={chatName}
				onSubmit={handleSubmit}
			/>
		</Box>
	)
}
