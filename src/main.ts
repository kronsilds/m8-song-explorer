// Entry point: loads the fonts and styles, starts the app and connects to the M8.

import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './style.css'

import { ExplorerApp } from './app/app'

const app = await ExplorerApp.start(document.getElementById('app') as HTMLElement)
void app.connect()
