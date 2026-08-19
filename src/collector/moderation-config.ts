// Configuração dos grupos privados de administração. Pura: só lê o ambiente.
//
// Dois grupos com papéis distintos, ambos só de admins:
//  - MODERATION_GROUP_JID: onde os moderadores conversam e comandam à vontade.
//  - LOG_GROUP_JID: onde cai o relatório de toda tentativa de comando.
//
// Nos dois, o comando digitado é preservado — são espaços fechados, o histórico ali é a trilha.
// Em qualquer OUTRO grupo apaga-se o comando de quem tem STATUS DE ADMIN no grupo, inclusive quando
// o comando é recusado (moderação, ainda que negada, não é assunto público). A mensagem de quem não
// tem galão nenhum fica onde está — o registro dela vive na trilha de auditoria.
// Decisão de 2026-08-19: antes apagava de todo mundo, autorizado ou não.
//
// A spec do /ban (2026-06-30) marcava "configuração via env" como fora de escopo. O caso de uso do
// grupo de log reverte isso deliberadamente: não há como referenciar um grupo específico sem
// nomeá-lo, e um JID de grupo não é segredo nem pertence ao código.

export interface ModerationConfig {
	moderationGroupJid: string | null
	logGroupJid: string | null
}

// Grupos onde o comando NÃO é apagado.
export function isPrivateAdminGroup(config: ModerationConfig, groupJid: string): boolean {
	return groupJid === config.moderationGroupJid || groupJid === config.logGroupJid
}

// Só apaga quando SABEMOS onde é o grupo de moderação. Sem a env, o bot não tem como distinguir
// "grupo público" de "sala dos moderadores" — e apagar mensagem de admin por engano é pior que
// não apagar. Fail-safe: na dúvida, não mexe.
export function shouldDeleteCommand(config: ModerationConfig, groupJid: string): boolean {
	if (!config.moderationGroupJid) return false
	return !isPrivateAdminGroup(config, groupJid)
}

function jid(value: string | undefined): string | null {
	const trimmed = value?.trim()
	if (!trimmed) return null
	// tolera o JID colado com espaços ou sem o sufixo — o operador copia isso do log ou da TUI.
	return trimmed.endsWith('@g.us') ? trimmed : `${trimmed}@g.us`
}

export function resolveModerationConfig(env: NodeJS.ProcessEnv): ModerationConfig {
	return {
		moderationGroupJid: jid(env.MODERATION_GROUP_JID),
		logGroupJid: jid(env.LOG_GROUP_JID),
	}
}
