import fs from 'fs'
import path from 'path'
import type { GroupInfo } from './types.js'

const CACHE_PATH = path.resolve('logs', 'group-metadata.json')

type GroupCache = Record<string, GroupInfo>

export function loadGroupCache(): GroupCache {
	if (!fs.existsSync(CACHE_PATH)) return {}
	return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
}

export function saveGroupCache(cache: GroupCache) {
	fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
	fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}
