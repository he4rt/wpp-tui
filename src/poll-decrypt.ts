import { createDecipheriv, createHmac, createHash } from 'crypto'
import { proto } from '@whiskeysockets/baileys'

interface PollVoteContext {
	pollEncKey: Buffer
	pollCreatorJid: string
	pollMsgId: string
	voterJid: string
}

interface EncryptedVote {
	encPayload: Buffer | string
	encIv: Buffer | string
}

function hmacSign(buffer: Buffer, key: Buffer): Buffer {
	return createHmac('sha256', key).update(buffer).digest()
}

function aesDecryptGCM(ciphertext: Buffer, key: Buffer, iv: Buffer, aad: Buffer): Buffer {
	const tagLength = 16
	const enc = ciphertext.subarray(0, ciphertext.length - tagLength)
	const tag = ciphertext.subarray(ciphertext.length - tagLength)
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAAD(aad)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(enc), decipher.final()])
}

export function decryptPollVote(vote: EncryptedVote, ctx: PollVoteContext): string[] {
	const encPayload = Buffer.isBuffer(vote.encPayload)
		? vote.encPayload
		: Buffer.from(vote.encPayload as string, 'base64')
	const encIv = Buffer.isBuffer(vote.encIv)
		? vote.encIv
		: Buffer.from(vote.encIv as string, 'base64')

	const sign = Buffer.concat([
		Buffer.from(ctx.pollMsgId),
		Buffer.from(ctx.pollCreatorJid),
		Buffer.from(ctx.voterJid),
		Buffer.from('Poll Vote'),
		new Uint8Array([1]),
	])

	// matches Baileys: hmacSign(pollEncKey, new Uint8Array(32))
	const key0 = hmacSign(ctx.pollEncKey, Buffer.alloc(32))
	const decKey = hmacSign(sign, key0)
	const aad = Buffer.from(`${ctx.pollMsgId}\0${ctx.voterJid}`)

	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	const voteMsg = proto.Message.PollVoteMessage.decode(decrypted)

	return (voteMsg.selectedOptions || []).map((opt) => Buffer.from(opt).toString('hex'))
}

export function sha256(data: string): string {
	return createHash('sha256').update(data).digest('hex')
}

export function buildOptionHashMap(options: string[]): Record<string, string> {
	const map: Record<string, string> = {}
	for (const opt of options) {
		map[sha256(opt)] = opt
	}
	return map
}
