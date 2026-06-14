import { Box, Text } from 'ink'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

interface QrViewProps {
	qrCode: string
}

export function QrView({ qrCode }: QrViewProps) {
	const [lines, setLines] = useState<string[]>([])

	useEffect(() => {
		QRCode.toString(qrCode, { type: 'utf8', margin: 2 }).then((str) => {
			setLines(str.split('\n'))
		})
	}, [qrCode])

	return (
		<Box flexDirection="column" alignItems="center" paddingY={1} flexGrow={1}>
			{lines.length === 0 ? (
				<Text dimColor>Generating QR code...</Text>
			) : (
				lines.map((line, i) => (
					<Text key={i} backgroundColor="white" color="black">
						{line}
					</Text>
				))
			)}
			<Box paddingTop={1}>
				<Text dimColor>Scan with WhatsApp {'>'} Settings {'>'} Linked Devices</Text>
			</Box>
		</Box>
	)
}
