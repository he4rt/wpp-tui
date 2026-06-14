// Shutdown gracioso do runner headless (ADR-0002 §graceful shutdown). SIGTERM/SIGINT param a
// coleta via stop() (fecha outbox/SQLite + encerra o socket) e então saem com código 0. Um timer
// de força (forceMs) garante saída com código 1 caso stop() trave. uncaughtException e
// unhandledRejection logam e saem com 1. Tudo é injetável (proc/exit/stop) para ser testável.

export interface ShutdownDeps {
	stop: () => Promise<void> | void
	log: (event: string, detail?: unknown) => void
	forceMs?: number                // padrão 10000
	proc?: NodeJS.EventEmitter      // injetável, padrão process
	exit?: (code: number) => void   // injetável, padrão process.exit
}

// Instala os listeners de shutdown e retorna uma função de uninstall que remove tudo e limpa o timer.
export function installShutdown(deps: ShutdownDeps): () => void {
	const forceMs = deps.forceMs ?? 10_000
	const proc: NodeJS.EventEmitter = deps.proc ?? process
	// process.exit é (code?) => never; aqui só precisamos do efeito de saída.
	const exit = deps.exit ?? ((code: number) => process.exit(code))

	let triggered = false
	let forceTimer: ReturnType<typeof setTimeout> | null = null

	// Garante que stop()/exit() rodem uma única vez, mesmo recebendo sinais repetidos ou um sinal
	// junto de uma exceção não tratada.
	const shutdown = (event: string, exitCode: number, detail?: unknown): void => {
		if (triggered) return
		triggered = true
		deps.log(event, detail)

		// Timer de força: se stop() travar, saímos com 1 de qualquer jeito. unref() para não
		// segurar o event loop vivo sozinho.
		forceTimer = setTimeout(() => {
			deps.log('shutdown_force_timeout')
			exit(1)
		}, forceMs)
		forceTimer.unref?.()

		Promise.resolve()
			.then(() => deps.stop())
			.then(
				() => {
					if (forceTimer) clearTimeout(forceTimer)
					exit(exitCode)
				},
				(err) => {
					if (forceTimer) clearTimeout(forceTimer)
					deps.log('shutdown_stop_error', err)
					exit(1)
				},
			)
	}

	const onSigterm = () => shutdown('SIGTERM', 0)
	const onSigint = () => shutdown('SIGINT', 0)
	const onUncaught = (err: unknown) => shutdown('uncaughtException', 1, err)
	const onUnhandled = (reason: unknown) => shutdown('unhandledRejection', 1, reason)

	proc.on('SIGTERM', onSigterm)
	proc.on('SIGINT', onSigint)
	proc.on('uncaughtException', onUncaught)
	proc.on('unhandledRejection', onUnhandled)

	return () => {
		proc.removeListener('SIGTERM', onSigterm)
		proc.removeListener('SIGINT', onSigint)
		proc.removeListener('uncaughtException', onUncaught)
		proc.removeListener('unhandledRejection', onUnhandled)
		if (forceTimer) clearTimeout(forceTimer)
	}
}
