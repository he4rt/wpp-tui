import { Box, Text } from 'ink'
import type { ChatEntry, ChatMessage } from '../types.js'

interface StatsViewProps {
	messages: ChatMessage[]
	chats: ChatEntry[]
	height: number
}

export function StatsView({ messages, chats, height }: StatsViewProps) {
	const topSenders = computeTopSenders(messages, 12)
	const typeDistro = computeTypeDistribution(messages)
	const groupStats = computeGroupStats(messages, chats)

	return (
		<Box flexDirection="row" height={height} overflow="hidden">
			<Box flexDirection="column" width="50%" borderStyle="single" borderColor="yellow" paddingX={1}>
				<Text bold underline color="yellow">TOP SENDERS</Text>
				<Box flexDirection="column" marginTop={1}>
					{topSenders.length === 0 && <Text dimColor>No data yet</Text>}
					{topSenders.map(({ name, count, bar }) => (
						<Box key={name} gap={1}>
							<Text dimColor>{String(count).padStart(3)}</Text>
							<Text color="yellow">{bar}</Text>
							<Text>{name}</Text>
						</Box>
					))}
				</Box>

				<Box flexDirection="column" marginTop={1}>
					<Text bold underline color="yellow">GROUPS</Text>
					<Box flexDirection="column" marginTop={1}>
						{groupStats.map(({ name, count, members }) => (
							<Box key={name} gap={1}>
								<Text dimColor>{String(count).padStart(3)} msgs</Text>
								<Text color="yellow">#</Text>
								<Text>{name}</Text>
								{members > 0 && <Text dimColor>({members})</Text>}
							</Box>
						))}
					</Box>
				</Box>
			</Box>

			<Box flexDirection="column" width="50%" borderStyle="single" borderColor="yellow" paddingX={1}>
				<Text bold underline color="yellow">MESSAGE TYPES</Text>
				<Box flexDirection="column" marginTop={1}>
					{typeDistro.map(({ type, count, bar }) => (
						<Box key={type} gap={1}>
							<Text dimColor>{String(count).padStart(3)}</Text>
							<Text color="green">{bar}</Text>
							<Text>{type}</Text>
						</Box>
					))}
				</Box>

				<Box flexDirection="column" marginTop={1}>
					<Text bold underline color="yellow">TOTALS</Text>
					<Box flexDirection="column" marginTop={1}>
						<Text>Messages: <Text bold color="yellow">{messages.length}</Text></Text>
						<Text>Chats:    <Text bold color="yellow">{chats.length}</Text></Text>
						<Text>Groups:   <Text bold color="yellow">{chats.filter((c) => c.chatType === 'group').length}</Text></Text>
						<Text>DMs:      <Text bold color="yellow">{chats.filter((c) => c.chatType === 'dm').length}</Text></Text>
					</Box>
				</Box>
			</Box>
		</Box>
	)
}

function computeTopSenders(messages: ChatMessage[], limit: number) {
	const counts = new Map<string, number>()
	for (const msg of messages) {
		const name = msg.pushName || 'unknown'
		counts.set(name, (counts.get(name) || 0) + 1)
	}
	const sorted = Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
	const max = sorted[0]?.[1] || 1
	return sorted.map(([name, count]) => ({
		name: name.length > 20 ? name.slice(0, 18) + '..' : name,
		count,
		bar: '█'.repeat(Math.max(1, Math.round((count / max) * 12))),
	}))
}

function computeTypeDistribution(messages: ChatMessage[]) {
	const counts = new Map<string, number>()
	for (const msg of messages) {
		counts.set(msg.content.type, (counts.get(msg.content.type) || 0) + 1)
	}
	const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
	const max = sorted[0]?.[1] || 1
	return sorted.map(([type, count]) => ({
		type,
		count,
		bar: '█'.repeat(Math.max(1, Math.round((count / max) * 20))),
	}))
}

function computeGroupStats(messages: ChatMessage[], chats: ChatEntry[]) {
	const counts = new Map<string, number>()
	for (const msg of messages) {
		if (msg.chatType === 'group') {
			counts.set(msg.chat, (counts.get(msg.chat) || 0) + 1)
		}
	}
	return chats
		.filter((c) => c.chatType === 'group')
		.map((c) => ({
			name: c.name.length > 25 ? c.name.slice(0, 23) + '..' : c.name,
			count: counts.get(c.jid) || 0,
			members: c.groupInfo?.size || 0,
		}))
		.sort((a, b) => b.count - a.count)
}
