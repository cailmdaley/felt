# UI layers and SDK

Shuttle's interface is three layers, and you can plug in at any of them.

| Layer | What it is | Use it to |
|---|---|---|
| **1. CLI and Core HTTP API** | The `shuttle` command and the daemon's stable routes | work from a terminal, script Shuttle, or write a UI or TUI from scratch in any language |
| **2. UI primitives SDK** | `/sdk/shuttle-sdk.js`, unstyled parts over the API | build a UI of your own and decide its look and layout |
| **3. Views and theme** | The board every daemon serves | use Shuttle in a browser, or add a view to the board |

The daemon decides what a task's state is and what may happen to it.
Layer 1 states that in a stable contract, Layer 2 turns it into accessible controls without choosing colors, fonts or layout, and Layer 3 chooses them.
Keeping them apart means you can replace any layer without rewriting the ones under it, and a UI of yours doesn't break when the board is redesigned.

## Layer 1: CLI and Core HTTP API

Everything Shuttle does with work can be done from a terminal:

| To | Run |
|---|---|
| Launch, steer and stop work | `shuttle install`, `resume`, `message`, `attach`, `pause`, `close` |
| Kill a live worker without recording a verdict | `shuttle kill <fiber>` |
| Turn a sentence into a constitution | `shuttle capture "<prompt>" --project-dir <dir>` |
| Run a tree of threads | `shuttle thread <parent> "<ask>"`, `shuttle threads <parent>` |
| Follow a family of threads | `shuttle board <fiber>`, `shuttle post --fiber <fiber> "<text>"` |
| Read a report page | `shuttle tapestry <fiber>` with `--path`, `--url`, `--open` or `--json` |
| List the files a fiber's workers sent | `shuttle sent-files ls <fiber>` |
| Let your own sessions become threads | `shuttle host ambient on`, then `shuttle adopt` from the session |

The [CLI reference](../reference/cli.md) has the rest.

For programs, the daemon serves the Core HTTP API under `/api/v1`.
Its OpenAPI 3.1 document is `contract/shuttle-api.json` in the repository, and each daemon serves the copy it was built with:

```sh
curl -s http://127.0.0.1:4000/api/v1/contract
```

The fifteen routes it describes are stable: they cover reading fibers, fleet and files, and creating, launching, messaging, changing and killing work.
Adding a route or an optional field leaves `api_level` alone; removing or renaming one raises it by one.
Build on those routes and ignore the rest of `/api/v1`, which belongs to the board.
[Core](../reference/api.md#core) in the API reference lists each one.

Requests that read or change a fiber are routed to the host that owns it.
Carry the `origin` a feed row gives you back with each request, and a UI on one machine works for the whole fleet.

## Layer 2: UI primitives SDK

Every daemon serves the SDK at `/sdk/shuttle-sdk.js`.
It is one self-contained ES module, so a page imports it with no bundler, package manager or build step.
Its popups and composite controls are built on Vercel's `@ui-sdk/core` and `@ui-sdk/web`, which handle keyboard navigation, focus return and ARIA.

It has three parts.

**Client and feed.**
`ShuttleClient` wraps all 15 Core routes (plus `/inbox`) to read fibers, the fleet and files, and to create, capture, launch, message, change and stop work; `client.url(path)` builds an address for any additional route.
`ShuttleFeed` polls the fleet's fibers and tells you when they change.
`DaemonBootingError`, `isDaemonBooting` and `daemonErrorMessage` sort out a daemon that is starting from one that failed.

**Domain model.**
These are plain functions over feed rows, with no DOM:

| Function | Answers |
|---|---|
| `attentionOf`, `isWaiting`, `isWorking` | whether a fiber waits on you, is working, or is quiet |
| `doingOf` | what it wants, or last said |
| `offersFor` | which lifecycle actions fit its current state |
| `buildFamilyTree` | which threads belong under which orchestrator |
| `groupPosts`, `kindWord` | how a stream of posts reads |
| `relativeAge` | how long ago |

**Structural primitives.**
Each builds accessible DOM with no skin.
All return an element except `createActionMenu`, which returns a controller, `{ element, offers, open, close, destroy }`:

| Function | Root `data-slot` | Draws |
|---|---|---|
| `createThreadRow(fiber, { now, ... })` | `shuttle-thread-row` | a thread on one line |
| `createPost(item, { now, ... })` | `shuttle-post` | one post, with its files |
| `createFilePreview(file, client, options)` | `shuttle-file-preview` | a picture, page or file card |
| `createActionMenu(fiber, client, options)` | `shuttle-action-menu` | the actions that fit the fiber, as a menu |
| `createLifecycleBar(fiber, client, options)` | `shuttle-lifecycle-bar` | the main actions, as a toolbar |
| `createComposer(fiber, client, options)` | `shuttle-composer` | a message box for the fiber |
| `createTapestryFrame(fiber, client, options)` | `shuttle-tapestry-frame` | the fiber's report page, sandboxed, or the public page it declares |
| `createTime(atMs, nowMs, options)` | `shuttle-time` | an age; `retimeAll(root, nowMs)` keeps a page's ages current |

Style the parts with `data-slot`, and state with the attributes beside it: `data-attention`, `data-turn`, `data-kind`, `data-waiting`, `data-grouped` and `data-density`.
The SDK contains no CSS skin, so your stylesheet never has to undo one.

## A complete personal UI

Save this as `~/.config/shuttle/ui/minimal/index.html` and open `http://127.0.0.1:4000/ui/minimal/`.
It lists live threads, what waits on you first, gives each a menu of actions, and opens a composer when you choose one.

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Minimal Shuttle</title>
<style>
  body { font: 16px/1.5 system-ui; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  #threads { list-style: none; padding: 0; }
  li { display: flex; gap: .5rem; border-bottom: 1px solid #ddd; }
  [data-slot="shuttle-thread-row"] { display: flex; gap: .75rem; flex: 1; min-width: 0; padding: .5rem 0; cursor: pointer; }
  [data-slot="doing"] { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-slot="age"] { color: #666; }
  [data-slot="shuttle-thread-row"][data-attention="waiting"] [data-slot="slug"] { color: #b45309; font-weight: 600; }
  [data-slot="shuttle-thread-row"][data-attention="working"] [data-slot="slug"] { color: #047857; }
  [data-slot="shuttle-action-menu"] ui-menu-content { margin: 0; padding: .25rem; border: 1px solid #999; background: #fff; color: #111; }
  [data-slot="shuttle-action-menu"] ui-menu-item { display: block; padding: .25rem .75rem; }
  [data-slot="shuttle-action-menu"] ui-menu-item[data-highlighted] { background: #e5e7eb; }
  [data-slot="shuttle-composer"] { display: flex; gap: .5rem; }
  [data-slot="shuttle-composer"] [data-slot="input"] { flex: 1; font: inherit; }
</style>
<h1>Threads</h1>
<p id="note" role="status"></p>
<ul id="threads"></ul>
<section id="message"></section>
<script type="module">
  import { ShuttleClient, ShuttleFeed, attentionOf, createThreadRow, createActionMenu, createComposer, daemonErrorMessage }
    from '/sdk/shuttle-sdk.js'
  const client = new ShuttleClient(), feed = new ShuttleFeed(client)
  const $ = id => document.getElementById(id), rank = { waiting: 0, working: 1, quiet: 2 }
  const refused = error => { $('note').textContent = daemonErrorMessage(error) }
  let drawn

  function compose(fiber) {
    const title = Object.assign(document.createElement('h2'), { textContent: `To ${fiber.fiber.name}` })
    $('message').replaceChildren(title, createComposer(fiber, client, { onSent: () => feed.refresh(), onError: refused }))
    $('message').querySelector('textarea').focus()
  }

  function item(fiber) {
    const li = document.createElement('li')
    const more = Object.assign(document.createElement('button'), { textContent: '⋯', ariaLabel: `Actions for ${fiber.fiber.name}` })
    const menu = createActionMenu(fiber, client, { onAction: () => feed.refresh(), onError: refused })
    more.onclick = () => menu.open({ anchor: more })
    li.append(createThreadRow(fiber, { now: Date.now(), onOpen: compose }), more, menu.element)
    return li
  }

  feed.subscribe(({ fibers, error }) => {
    $('note').textContent = error ?? ''
    if (fibers === drawn) return // an unchanged feed keeps its rows, focus and open menu
    drawn = fibers
    const live = fibers.filter(f => f.column && f.column !== 'tempered' && f.column !== 'discarded')
    live.sort((a, b) => rank[attentionOf(a)] - rank[attentionOf(b)])
    $('threads').replaceChildren(...live.map(item))
  })
  feed.start()
</script>
</html>
```

The daemon reads the file on each request, so an edit needs only a reload.
Every color and border comes from the page's own stylesheet, which selects the SDK's parts by `data-slot` and their state by `data-attention`.

- **Subscribe once, draw when the rows change.** A poll that finds nothing new keeps the same `fibers` array, so comparing it keeps focus and any open menu in place. A changed feed redraws the list.
- **A row needs the time.** `now` is the instant its age counts to. `onOpen` makes it a keyboard-operable button; without it the row is plain text.
- **A menu is a controller.** `createActionMenu` returns `{ element, offers, open, close, destroy }`. Put `element` on the page and call `open({ anchor })`; `offers` is the list it shows, what `offersFor` says by default. It sends the choice, and returns focus to the anchor.
- **Writes carry the owner.** The client takes `origin` from the row, so the page works for every host in the fleet.
- **The composer dispatches.** Sending a message to a fiber with no live worker starts one, on that fiber's own agent.

Pages served from this folder act as you; see [Personal UIs](configuration.md#personal-uis).


## Layer 3: views, layout and theme

The default board is built from views, laid out and skinned independently of them.

### Views are plugins

A view implements `BoardViewPlugin` and is registered in `ui/src/board/views/ViewRegistry.ts`:

```ts
import { registerView, unregisterView, listViews, type BoardViewPlugin } from './ViewRegistry.js'

const notes: BoardViewPlugin = {
  id: 'notes',
  title: 'Notes',
  hotkey: '3',
  mount(host, ctx) { host.textContent = `${ctx.cards.length} cards` },
  refresh(ctx) { /* new board data: patch in place */ },
  unmount() { /* drop timers and listeners */ },
}

registerView(notes)
listViews()               // every registered view
unregisterView('notes')
```

`mount`, `refresh` and `unmount` are required.
`hotkey` is optional too: without one, a view takes the first free digit from 2 to 9.
`optional: true` gives the view no tab, so it is reached by its hotkey, its address or code.
Optional hooks let a view join the board's own features: `keydown` takes a keystroke the board left alone, `reveal(id, origin)` shows a fiber Rex moved to, `followRex(id, origin)` shows where that fiber's worker speaks, `findScope` says what Find searches, and `show` goes to a place Find picked.
The board owns the host element, the tab and the data; the view owns what is inside its host.
Desk is the board's own page, Channels is a registered view, and the Fleet Map is a page of its own at `/map`.
A view ships in the board's bundle: adding one means building the board.
For something of your own without a build, use a personal UI.

### Theming is CSS

Typography comes from the tokens in `ui/src/styles/type.css`, and color and surface from CSS custom properties.
A view uses the tokens and doesn't name a font or color itself, so the skin changes without touching a view.
[Constitution themes](../concepts/themes.md) change a channel's materials the same way.
[The board's elements](../dev/elements.md) records the board's own proportions, and [UI SDK in the board](../dev/ui-sdk.md) how it uses `@ui-sdk/*`.

## Choose where to plug in

- A script, a TUI or another language: Layer 1.
- A page of your own, with your layout: Layer 2.
- A new view inside the board: Layer 3, in a checkout ([Building and deploying](../dev/build-and-deploy.md)).

## Continue

- [Personal UIs](configuration.md#personal-uis): where files go and who can read them.
- [Interactive tutorial](../tutorial.md): Module 7 builds a page with your agent.
- [Daemon HTTP API](../reference/api.md): the Core routes.
- [The board](board.md): the default UI, for the person using it.
