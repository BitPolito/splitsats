import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Inject WebLN mock in development when Alby is not installed
if (import.meta.env.DEV) {
  const { injectDevMock } = await import('./lib/lightning.js')
  injectDevMock()
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
