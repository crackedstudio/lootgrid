import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthGate from './components/AuthGate.jsx'

/**
 * The gate wraps App rather than sitting inside it, because `useGameState()`
 * fires its first requests on mount. Mounting App before a session key exists
 * would burn those calls as 401s and show an empty grid the player would read
 * as a broken game.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
