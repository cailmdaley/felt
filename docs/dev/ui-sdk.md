# UI SDK in the board

The vanilla-DOM board uses UI SDK 0.1.0-beta.1 for action and conversation menus.
`conversationMenu.ts` builds the shipped `@ui-sdk/web/menu` elements; the SDK owns positioning, menu keys, typeahead, disabled-item semantics, dismissal and focus return.
The board owns actions, presentation and the gestures that ask for a menu.

## Choose the smallest fit

Use a shipped `@ui-sdk/web/<component>` when its composition fits, including imperative opens and point anchors.
Use public core behaviours with `definePrimitive` when the interaction is genuinely bespoke, not to reproduce a shipped component with fewer tags.
Keep domain code such as the Chronicle's civil days, document-frame forwarding and lifecycle actions outside the SDK.
Never import `@ui-sdk/core/internal/*`.
Read the installed package's `docs/llms.txt`, the component page and the relevant shared guides before adopting another widget.

## Build and drive elements

Import a component entry once to register its tags, then use `document.createElement`.
Construct the subtree before appending its root to the document; `api` is available on a connected root.
Use attributes for scalar options and properties for rich values supported by the element's types.
For example:

```ts
import '@ui-sdk/web/menu'

const menu = document.createElement('ui-menu')
menu.setAttribute('modal', 'false')
const content = document.createElement('ui-menu-content')
content.setAttribute('aria-label', 'Actions')
const item = document.createElement('ui-menu-item')
item.setAttribute('value', 'rename')
item.textContent = 'Rename'
content.append(item)
menu.append(content)
document.body.append(menu)
menu.addEventListener('action', event => rename(event.detail.value))
opener.focus({ preventScroll: true })
void menu.api.open({ anchor: opener, focus: 'first' }) // or anchor: { x, y }
```

A native button or link inside an `as-child` item owns focus, classes and SDK state attributes.
Keep popups outside clickable rows: their events use the normal DOM ancestry, even in the top layer.
Set `modal="false"` when an outside press should also reach its target.
Temporary menu teardown waits until close completion and the SDK's focus-return microtask have finished; lifecycle verbs then run so they can focus their undo control or confirmation.
`conversationMenu.ts` handles radio choices through the close event's `item-press` reason because radio items don't emit a plain item's `select` event.
A one-time focus-in listener starts destination pickers on their remembered choice; subsequent focus movement belongs to the SDK.

The board's capture-phase key handlers yield through `blockingDialogOpen()` while an SDK menu has `data-open`.
Extend that guard for each new popup that owns keys; a bubbling stop alone cannot protect a popup from an earlier capture handler.
Menu-launch gestures use the board's existing context-key and long-press bindings.
The shared hold binding cancels on ancestor scroll and drag, clears selection and coordinates nested row/pill presses; the SDK context trigger doesn't supply that full contract.
Don't delete the shared gesture helpers as a side effect of porting another menu.

## Style the behaviour target

Declare `@layer ui-sdk;` before the component rules.
The SDK injects its structural CSS into that layer; our unlayered CSS supplies the board's look.
Don't import `@ui-sdk/core/web.css`.
Scope rules with a board class, select SDK parts with `data-slot`, and select state with `data-highlighted`, `data-disabled`, `data-checked` and `data-open`.
State flags are present or absent, not string booleans.
Keep `data-part` for board-owned structure and retain shared verb classes where the same control appears outside a menu.
Let the SDK write positioning, visibility and top-layer styles; use its `--available-height` for overflow.

## Test people, not wrappers

`ui/test/setup.ts` supplies jsdom's missing popover, animation, scrolling, media-query and resize-observer APIs.
These stubs don't simulate native top-layer behaviour or layout.
Await `settle()` from `board/testFixtures.ts` after mounting, opening, selecting or closing: child binding is asynchronous.
Send keys to the focused element, not `document` or `window`, and query roles and accessible names.
Disabled menu items remain focusable but cannot act.
`checkPattern(content, 'menu')` from `@ui-sdk/core/testing` exercises keys too, including Escape; reopen before further assertions.
The async `workspace/testActs.ts` helpers exercise the real verb face and caret menu.

Run `npm test`, `npm run build`, `npm run e2e`, and the repository's Hygiene Go test.
`e2e/actionMenu.mjs` checks both themes at desktop and phone widths, including real touch hold and keyboard link activation, against the file harness.
Set `UI_SDK_SHOTS` to save its screenshots.
Use headless browsers only.

## Beta focus limitation

A menu opened from code can lose its content's `final-focus` selector when Escape unmounts that content.
This reproduces in Chrome without board handlers or application teardown; see [the reproduction](ui-sdk-final-focus.md).
Our menus focus the opener before `api.open()`, using the controller's documented return-to-previous-focus behaviour instead.
Test focus in a browser before relying on `final-focus` in another slice, particularly when an action removes its trigger.
