import { Box, Text } from 'ink'
import { Spinner } from '@inkjs/ui'
import type { ActiveTab, ConnectionStatus } from '../types.js'

interface HeaderProps {
	status: ConnectionStatus
	me: string
	activeTab: ActiveTab
}

const TABS: { key: ActiveTab; label: string; color: string }[] = [
	{ key: 'chat', label: '1:Chat', color: 'cyan' },
	{ key: 'stats', label: '2:Stats', color: 'yellow' },
	{ key: 'debug', label: '3:Debug', color: 'red' },
]

export function Header({ status, me, activeTab }: HeaderProps) {
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
			<Box gap={1}>
				<Text bold color="green">WA Bot</Text>
				<Text dimColor>|</Text>
				{TABS.map((tab) => {
					const isActive = activeTab === tab.key
					return (
						<Text key={tab.key} bold={isActive} color={isActive ? tab.color : undefined} dimColor={!isActive}>
							{isActive ? `[${tab.label}]` : ` ${tab.label} `}
						</Text>
					)
				})}
			</Box>
			<Box gap={1}>
				{status === 'disconnected' && <Text color="red">● OFF</Text>}
				{status === 'connecting' && <Spinner label="" />}
				{status === 'qr' && <Text color="yellow">● QR</Text>}
				{status === 'connected' && <Text color="green">●</Text>}
				{me && <Text dimColor>{me}</Text>}
				<Text dimColor>Tab:switch Ctrl+Q:quit</Text>
			</Box>
		</Box>
	)
}
