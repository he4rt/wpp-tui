import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMessageLookup } from '../../src/collector/message-lookup.js'

const HOJE = new Date('2026-08-19T18:00:00.000Z')
const now = () => HOJE

// Escreve um logs/messages.upsert/<dia>.json no formato real do event-logger (NDJSON).
function trilha(linhas: Array<{ dia: string; messages: unknown[] }>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-'))
	for (const { dia, messages } of linhas) {
		const entry = { timestamp: `${dia}T12:00:00.000Z`, event: 'messages.upsert', data: { type: 'notify', messages } }
		fs.appendFileSync(path.join(dir, `${dia}.json`), JSON.stringify(entry) + '\n')
	}
	return dir
}

const msg = (id: string, over: Record<string, unknown> = {}) => ({
	key: { remoteJid: '120363000000000002@g.us', participant: '100000000000004@lid', id },
	pushName: 'Fulano',
	messageTimestamp: 1_755_000_000,
	message: { conversation: `texto de ${id}` },
	...over,
})

test('acha a mensagem do dia pelo id, com texto, autor e horário', async () => {
	const dir = trilha([{ dia: '2026-08-19', messages: [msg('A1'), msg('A2')] }])
	const achado = await createMessageLookup({ dir, now }).find('A2')

	assert.equal(achado?.text, 'texto de A2')
	assert.equal(achado?.pushName, 'Fulano')
	assert.equal(achado?.sentAt, '2025-08-12T12:00:00.000Z')
	assert.equal(achado?.kind, 'conversation')
})

test('procura em dias anteriores (mensagem antiga apagada hoje)', async () => {
	const dir = trilha([{ dia: '2026-08-17', messages: [msg('ANTIGA')] }])
	assert.equal((await createMessageLookup({ dir, now, days: 3 }).find('ANTIGA'))?.text, 'texto de ANTIGA')
	// com janela de 1 dia, o arquivo de 17/08 nem é aberto
	assert.equal(await createMessageLookup({ dir, now, days: 1 }).find('ANTIGA'), null)
})

test('id inexistente devolve null; diretório ausente também', async () => {
	const dir = trilha([{ dia: '2026-08-19', messages: [msg('A1')] }])
	assert.equal(await createMessageLookup({ dir, now }).find('NAO_EXISTE'), null)
	assert.equal(await createMessageLookup({ dir: path.join(dir, 'vazio'), now }).find('A1'), null)
	assert.equal(await createMessageLookup({ dir, now }).find(''), null)
})

test('linha corrompida não impede achar a mensagem nas outras linhas', async () => {
	const dir = trilha([{ dia: '2026-08-19', messages: [msg('BOA')] }])
	// simula um append interrompido no meio (crash), que deixa JSON truncado no arquivo
	fs.appendFileSync(path.join(dir, '2026-08-19.json'), '{"data":{"messages":[{"key":{"id":"BOA"\n')

	assert.equal((await createMessageLookup({ dir, now }).find('BOA'))?.text, 'texto de BOA')
})

test('legenda de mídia serve como conteúdo; mídia sem legenda devolve o tipo', async () => {
	const dir = trilha([{
		dia: '2026-08-19',
		messages: [
			msg('COM_LEGENDA', { message: { imageMessage: { caption: 'olha o print' } } }),
			msg('SEM_LEGENDA', { message: { audioMessage: { seconds: 3 } } }),
		],
	}])
	const lookup = createMessageLookup({ dir, now })

	assert.equal((await lookup.find('COM_LEGENDA'))?.text, 'olha o print')
	const audio = await lookup.find('SEM_LEGENDA')
	assert.equal(audio?.text, null)
	assert.equal(audio?.kind, 'audioMessage')
})

test('reenvio do mesmo id: a versão mais recente do arquivo vence', async () => {
	const dir = trilha([{ dia: '2026-08-19', messages: [msg('R1')] }])
	const entry = {
		timestamp: '2026-08-19T13:00:00.000Z',
		event: 'messages.upsert',
		data: { messages: [msg('R1', { message: { conversation: 'versão corrigida' } })] },
	}
	fs.appendFileSync(path.join(dir, '2026-08-19.json'), JSON.stringify(entry) + '\n')

	assert.equal((await createMessageLookup({ dir, now }).find('R1'))?.text, 'versão corrigida')
})
