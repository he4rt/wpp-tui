import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogContent } from '../src/history.js'

test('lê NDJSON (1 objeto por linha)', () => {
	const content = '{"timestamp":"t1","data":{"a":1}}\n{"timestamp":"t2","data":{"a":2}}\n'
	const out = parseLogContent(content)
	assert.equal(out.length, 2)
	assert.equal(out[0].timestamp, 't1')
	assert.deepEqual(out[1].data, { a: 2 })
})

test('compat: lê formato antigo (array JSON único)', () => {
	const content = '[{"timestamp":"t1","data":{"a":1}},{"timestamp":"t2","data":{"a":2}}]'
	const out = parseLogContent(content)
	assert.equal(out.length, 2)
	assert.equal(out[0].timestamp, 't1')
})

test('ignora linhas vazias e corrompidas sem quebrar', () => {
	const content = '{"timestamp":"t1","data":1}\n\n{lixo parcial\n{"timestamp":"t2","data":2}\n'
	const out = parseLogContent(content)
	assert.deepEqual(out.map((e) => e.timestamp), ['t1', 't2'])
})

test('conteúdo vazio retorna []', () => {
	assert.deepEqual(parseLogContent(''), [])
	assert.deepEqual(parseLogContent('   \n  '), [])
})
