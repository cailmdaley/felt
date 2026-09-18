/** Browser regression checks for raw settings drafts. Run from ui/ with node
 * scripts/check-file-editor.mjs. CHROME_PATH can select a local browser. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const dir = await mkdtemp(resolve('.file-editor-check-'))
let server, browser
try {
  await writeFile(resolve(dir, 'index.html'), '<div id="root"></div><script type="module" src="./entry.tsx"></script>')
  await writeFile(resolve(dir, 'entry.tsx'), `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FileEditor} from '../src/forms/settings/FileEditor';
    import {SettingsDraftContext} from '../src/forms/settings/SettingsDraftContext';
    const host = {origin:'', host:'test', label:'Test', isLocal:true, hubHost:'test', stale:false};
    const notify = (_id, dirty, busy) => { document.body.dataset.dirty = String(dirty || busy) };
    function App() {
      const [token, setToken] = useState(0);
      const [locked, setLocked] = useState(false);
      return <SettingsDraftContext.Provider value={notify}>
        <button onClick={() => setToken(n => n+1)}>Refresh</button>
        <button onClick={() => setLocked(v => !v)}>Lock</button>
        <FileEditor shuttleBase="" host={host} id="agents" reloadToken={token}
          onSaved={() => setToken(n => n+1)} readOnlyReason={locked ? 'Managed by environment' : undefined}/>
      </SettingsDraftContext.Provider>
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `)
  server = await createServer({configFile:false, plugins:[react()], optimizeDeps:{entries:[resolve(dir, 'index.html')]}, server:{port:0, host:'127.0.0.1'}})
  await server.listen()
  browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true})
  const page = await browser.newPage()
  let disk = 'original', digest = 'one', conflict = false, pendingSave
  const file = () => ({host:'test', id:'agents', path:'/tmp/agents.json', exists:true, text:disk, digest})
  await page.route('**/api/v1/config/agents', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:file()})
    const body = route.request().postDataJSON()
    if (conflict) return route.fulfill({status:409, json:{error:'File changed on disk'}})
    await new Promise(resolve => { pendingSave = resolve })
    disk = body.text; digest = 'saved'
    await route.fulfill({json:file()})
  })
  await page.goto(`${server.resolvedUrls.local[0]}${basename(dir)}/index.html`)
  const fold = page.locator('details > summary').first()
  const editor = page.locator('textarea')
  await fold.click()
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'original')
  await editor.fill('draft')
  await fold.click(); await fold.click()
  assert.equal(await editor.inputValue(), 'draft', 'fold keeps draft')
  disk = 'external'; digest = 'two'
  await page.getByRole('button', {name:'Refresh', exact:true}).click()
  assert.equal(await editor.inputValue(), 'draft', 'structured refresh keeps draft')
  assert.equal(await page.locator('body').getAttribute('data-dirty'), 'true')
  conflict = true
  await page.getByRole('button', {name:'Save changes', exact:true}).click()
  await page.getByRole('button', {name:'Review current file', exact:true}).click()
  await page.getByText('Current file on disk', {exact:true}).click()
  assert.equal(await page.locator('pre').textContent(), 'external')
  assert.equal(await editor.inputValue(), 'draft', 'conflict review keeps draft')
  conflict = false
  await page.getByRole('button', {name:'Save changes', exact:true}).click()
  await page.waitForFunction(() => document.querySelector('textarea')?.readOnly)
  assert.equal(await editor.getAttribute('readonly'), '', 'save locks typing')
  pendingSave()
  await page.waitForFunction(() => document.body.dataset.dirty === 'false')
  assert.equal(disk, 'draft')
  await page.getByRole('button', {name:'Lock', exact:true}).click()
  assert.equal(await editor.getAttribute('readonly'), '', 'override locks typing')
  assert.equal(await page.getByRole('button', {name:'Save changes', exact:true}).isDisabled(), true)
  console.log('PASS: fold, refresh, dirty reporting, conflict review, save lock, read-only override')
} finally {
  await browser?.close()
  await server?.close()
  await rm(dir, {recursive:true, force:true})
}
