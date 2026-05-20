import { Box, Text } from 'ink'
import { Spinner } from '@inkjs/ui'
import type { ConnectionStatus } from '../types.js'

interface HeaderProps {
	status: ConnectionStatus
	me: string
}

export function Header({ status, me }: HeaderProps) {
	return (
		<Box borderStyle="round" paddingX={1} justifyContent="space-between">
			<Text bold color="green">WhatsApp Bot TUI</Text>
			<Box gap={2}>
				{status === 'disconnected' && <Text color="red">● Disconnected</Text>}
				{status === 'connecting' && <Spinner label="Connecting..." />}
				{status === 'qr' && <Text color="yellow">● Scan QR Code</Text>}
				{status === 'connected' && (
					<>
						<Text color="green">● Connected</Text>
						{me && <Text dimColor>{me}</Text>}
					</>
				)}
			</Box>
		</Box>
	)
}
