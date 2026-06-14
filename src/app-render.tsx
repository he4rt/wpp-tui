import { render } from 'ink'
import { App } from './app.js'

// Render da TUI extraído do entrypoint (ADR-0001). O index.tsx importa este módulo
// dinamicamente só no modo interativo — assim o Ink/React nunca é carregado no headless.
export function renderApp(): void {
	render(<App />, {
		alternateScreen: true,
		incrementalRendering: true,
		patchConsole: true,
	})
}
