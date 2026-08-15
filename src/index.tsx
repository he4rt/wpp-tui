// Entrypoint/roteador (ADR-0001/0003): decide entre Comando de pareamento, runner headless e TUI
// interativa, importando dinamicamente só o que o modo escolhido precisa — assim o Ink/React e o
// Coletor NUNCA são carregados fora do modo que os usa.
//
// Gatilhos, em ordem: flag --pair (pareamento one-shot, ADR-0003) > --headless / env HEADLESS
// verdadeiro ("1"/"true"/"yes") > TUI (default).
const pair = process.argv.includes('--pair')
const headless =
	process.argv.includes('--headless') ||
	['1', 'true', 'yes'].includes(String(process.env.HEADLESS || '').toLowerCase())

if (pair) {
	const { runPairingCli } = await import('./pairing.js')
	const code = await runPairingCli(process.argv, process.env)
	process.exit(code)
} else if (headless) {
	const { runHeadless } = await import('./headless.js')
	await runHeadless()
} else {
	const { renderApp } = await import('./app-render.js')
	renderApp()
}

// `export {}` força o TS a tratar este arquivo como módulo ESM — sem isso, o top-level await
// dos dynamic import() acima é rejeitado (TS1375). Não muda o runtime (já é ESM via "type":"module").
export {}
