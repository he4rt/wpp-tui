import { render } from 'ink'
import { App } from './app.js'

render(<App />, {
	alternateScreen: true,
	incrementalRendering: true,
	patchConsole: true,
})
