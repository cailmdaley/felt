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
    import {SettingsDialog} from '../src/forms/settings/SettingsDialog';
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
    function DialogApp() {
      const [open, setOpen] = useState(true);
      return open ? <SettingsDialog shuttleBase="" hosts={[
        {...host, feltStores:[], projects:[]},
        {...host, origin:'remote', host:'remote', label:'Remote', isLocal:false, feltStores:[], projects:[]}
      ]} onClose={() => setOpen(false)}/> : <p>Settings closed</p>;
    }
    createRoot(document.getElementById('root')).render(location.search ? <DialogApp/> : <App/>);
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

  const dialogPage = await browser.newPage()
  const writes = []
  let finishWrite
  const config = (id, owner) => ({host:owner, id, path:`/tmp/${id}.json`, exists:true,
    text:'[]', entries:[], digest:'initial', env_override:null})
  await dialogPage.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const owner = url.searchParams.get('origin') || 'test'
    if (request.method() === 'POST') {
      writes.push({path:url.pathname, body:request.postDataJSON()})
      // The request stays pending until the test has tried every exit.
      await new Promise(resolve => { finishWrite = resolve })
      return route.fulfill({json:{...config('projects', 'test'), text:writes.at(-1).body.text}})
    }
    if (url.pathname === '/api/v1/config') {
      return route.fulfill({json:{host:owner, files:['stores','projects','agents','remotes'].map(id => config(id, owner))}})
    }
    if (url.pathname.startsWith('/api/v1/config/')) {
      return route.fulfill({json:config(url.pathname.split('/').at(-1), owner)})
    }
    if (url.pathname === '/api/v1/felt-stores') {
      return route.fulfill({json:{host:'test', origins:{test:{kind:'local', display:'Test'},remote:{host:'remote',display:'Remote'}}}})
    }
    return route.fulfill({status:404,json:{error:`Unexpected fixture API: ${url.pathname}`}})
  })
  const openDialog = async () => {
    await dialogPage.goto(`${server.resolvedUrls.local[0]}${basename(dir)}/index.html?dialog`)
    await dialogPage.getByRole('button', {name:'Projects', exact:true}).click()
    await dialogPage.getByRole('textbox', {name:'Add a project', exact:true}).waitFor()
  }
  const button = name => dialogPage.getByRole('button', {name, exact:true})
  const hostPicker = dialogPage.getByRole('combobox', {name:'Which host to configure'})
  const pathInput = dialogPage.getByRole('textbox', {name:'Add a project', exact:true})
  const expectGuard = async () => {
    await button('Keep editing').waitFor()
    assert.equal(await dialogPage.getByRole('dialog').count(), 1)
  }
  await openDialog()
  await pathInput.fill('/tmp/unsaved-project')
  await button('Stores').click(); await expectGuard()
  await button('Keep editing').click()
  assert.equal(await pathInput.inputValue(), '/tmp/unsaved-project', 'cancel preserves typed project path')
  await hostPicker.selectOption('remote'); await expectGuard()
  assert.equal(await hostPicker.inputValue(), '', 'host remains unchanged while deciding')
  await button('Keep editing').click()
  await dialogPage.keyboard.press('Escape'); await expectGuard()
  await button('Keep editing').click()
  await button('Done').click(); await expectGuard()
  await button('Keep editing').click()
  await button('Stores').click(); await expectGuard()
  await button('Discard edits').click()
  await dialogPage.getByRole('textbox', {name:'Add a store', exact:true}).waitFor()
  await button('Projects').click()
  assert.equal(await pathInput.inputValue(), '', 'discard removes project draft')

  // A file draft guards host changes and close gestures just like a typed path.
  await dialogPage.getByText('projects.json', {exact:true}).click()
  const raw = dialogPage.locator('textarea')
  await raw.fill('["/tmp/draft"]')
  await hostPicker.selectOption('remote'); await expectGuard()
  await button('Keep editing').click()
  assert.equal(await raw.inputValue(), '["/tmp/draft"]')
  await dialogPage.keyboard.press('Escape'); await expectGuard()
  await button('Keep editing').click()
  await button('Done').click(); await expectGuard()
  await button('Keep editing').click()

  // A write cannot be discarded: section, host, Escape and Done all wait.
  await button('Save changes').click()
  await dialogPage.waitForFunction(() => document.querySelector('textarea')?.readOnly)
  for (const leave of [
    () => button('Stores').click(),
    () => hostPicker.selectOption('remote'),
    () => dialogPage.keyboard.press('Escape'),
    () => button('Done').click(),
  ]) {
    await leave()
    await dialogPage.getByText('Saving changes… Wait for this write to finish before leaving.', {exact:true}).waitFor()
    assert.equal(await hostPicker.inputValue(), '')
    assert.equal(await raw.inputValue(), '["/tmp/draft"]')
    assert.equal(await button('Discard edits').count(), 0, 'pending save offers no discard')
  }
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.origin, '')
  finishWrite()
  await dialogPage.waitForFunction(() => !document.querySelector('textarea')?.readOnly)
  await button('Done').click()
  await dialogPage.getByText('Settings closed', {exact:true}).waitFor()

  // Explicit discard completes the requested host switch, and then close.
  await openDialog()
  await pathInput.fill('/tmp/discard-me')
  await hostPicker.selectOption('remote'); await expectGuard()
  await button('Discard edits').click()
  assert.equal(await hostPicker.inputValue(), 'remote')
  await pathInput.fill('/tmp/remote-draft')
  await button('Done').click(); await expectGuard()
  await button('Discard edits').click()
  await dialogPage.getByText('Settings closed', {exact:true}).waitFor()
  assert.equal(writes.length, 1, 'draft navigation never writes configuration')
  console.log('PASS: dialog typed/raw drafts, section/host/Escape/Done guards, cancel/discard, pending-write navigation lock')
} finally {
  await browser?.close()
  await server?.close()
  await rm(dir, {recursive:true, force:true})
}
