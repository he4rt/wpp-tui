import { Box, Text } from 'ink'
import type { ConnectionStatus, DebugEvent } from '../types.js'

interface DebugViewProps {
	events: DebugEvent[]
	status: ConnectionStatus
	connectedAt: Date | null
	messageCount: number
	chatCount: number
	height: number
	scrollOffset: number
}

const EVENT_COLORS: Record<string, string> = {
	'messages.upsert': 'cyan',
	'messages.update': 'blue',
	'messages.reaction': 'magenta',
	'connection.update': 'green',
	'presence.update': 'gray',
	'chats.update': 'yellow',
	'creds.update': 'gray',
	'contacts.update': 'gray',
	'message-receipt.update': 'gray',
	'group.member-tag.update': 'yellow',
}

export function DebugView({ events, status, connectedAt, messageCount, chatCount, height, scrollOffset }: DebugViewProps) {
	const infoHeight = 5
	const logHeight = height - infoHeight - 4

	const visibleEvents = events.slice(
		Math.max(0, events.length - logHeight - scrollOffset),
		events.length - scrollOffset,
	)

	return (
		<Box flexDirection="column" height={height} overflow="hidden">
			<Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} height={logHeight + 2}>
				<Box justifyContent="space-between">
					<Text bold underline color="red">EVENT LOG</Text>
					{scrollOffset > 0 && (
						<Text dimColor>scrolled {scrollOffset} up — ↓ to go back</Text>
					)}
					{scrollOffset === 0 && (
						<Text dimColor>{events.length} events — ↑↓ to scroll</Text>
					)}
				</Box>
				<Box flexDirection="column" marginTop={1}>
					{visibleEvents.length === 0 && <Text dimColor>No events yet...</Text>}
					{visibleEvents.map((ev, i) => (
						<Box key={i} gap={1}>
							<Text dimColor>
								{ev.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
							</Text>
							<Text color={EVENT_COLORS[ev.event] || 'white'} bold>
								{ev.event.padEnd(24).slice(0, 24)}
							</Text>
							<Text wrap="truncate">{ev.summary}</Text>
						</Box>
					))}
				</Box>
			</Box>

			<Box flexDirection="row">
				<Box flexDirection="column" width="50%" borderStyle="single" borderColor="red" paddingX={1}>
					<Text bold underline color="red">CONNECTION</Text>
					<Text>Status:     <Text bold color={status === 'connected' ? 'green' : 'yellow'}>{status}</Text></Text>
					<Text>Uptime:     <Text bold>{connectedAt ? formatUptime(connectedAt) : '—'}</Text></Text>
				</Box>
				<Box flexDirection="column" width="50%" borderStyle="single" borderColor="red" paddingX={1}>
					<Text bold underline color="red">STORE</Text>
					<Text>Messages:   <Text bold>{messageCount}</Text></Text>
					<Text>Chats:      <Text bold>{chatCount}</Text></Text>
					<Text>Events:     <Text bold>{events.length}</Text></Text>
				</Box>
			</Box>
		</Box>
	)
}

function formatUptime(since: Date): string {
	const ms = Date.now() - since.getTime()
	const secs = Math.floor(ms / 1000)
	const mins = Math.floor(secs / 60)
	const hours = Math.floor(mins / 60)
	if (hours > 0) return `${hours}h ${mins % 60}m`
	if (mins > 0) return `${mins}m ${secs % 60}s`
	return `${secs}s`
}
