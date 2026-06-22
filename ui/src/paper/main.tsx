import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PaperApp } from './PaperApp'
import './paper.css'

/**
 * The ASTRA paper entry. Mounted in an <iframe> by the fiber panel when an
 * embed resolves to an `astra.yaml`; the source astra.yaml is selected by
 * query params:
 *
 *   paper.html?path=<abs project dir>&origin=<id>   production (daemon bakes)
 *   paper.html?fixture=iris                          dev: a locally-baked fixture
 */
const params = new URLSearchParams(window.location.search)
const args = {
  path: params.get('path'),
  origin: params.get('origin'),
  universe: params.get('universe'),
  fixture: params.get('fixture'),
}

const host = document.getElementById('paper')
if (!host) throw new Error('#paper host element is missing')

createRoot(host).render(
  <StrictMode>
    <PaperApp {...args} />
  </StrictMode>,
)
