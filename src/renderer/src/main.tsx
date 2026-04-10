import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
// highlight.js theme — applied to <code class="hljs language-*"> elements
// emitted by rehype-highlight. Loaded once globally; the cost is one CSS
// parse at startup, no per-render JS work.
import 'highlight.js/styles/github-dark.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
