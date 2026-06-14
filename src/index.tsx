// Entrypoint/roteador (ADR-0001): decide entre TUI interativa e runner headless e importa
// dinamicamente só o que o modo escolhido precisa — assim o Ink/React NUNCA é carregado no
// headless. Gatilho: flag --headless OU env HEADLESS verdadeiro ("1"/"true"/"yes").
const headless =
	process.argv.includes('--headless') ||
	['1', 'true', 'yes'].includes(String(process.env.HEADLESS || '').toLowerCase())

if (headless) {
	const { runHeadless } = await import('./headless.js')
	await runHeadless()
} else {
	const { renderApp } = await import('./app-render.js')
	renderApp()
}

// `export {}` força o TS a tratar este arquivo como módulo ESM — sem isso, o top-level await
// dos dynamic import() acima é rejeitado (TS1375). Não muda o runtime (já é ESM via "type":"module").
export {}
