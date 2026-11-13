# UI SDK in the board

The board uses UI SDK 0.1.0-beta.1 (`@ui-sdk/core`, `@ui-sdk/web`, `@ui-sdk/react`, pinned exactly) for the behaviour of its overlays and composite controls: positioning, keys, typeahead, dismissal, focus containment and return, inert backgrounds and ARIA.
The board owns actions, presentation, the gestures that ask for a popup, and its own key grammar.

| Widget | Where | SDK entry |
|---|---|---|
| Action, row and conversation menus | `board/conversationMenu.ts` | `@ui-sdk/web/menu` |
| Move menu | `board/MoveMenu.ts` | `@ui-sdk/web/menu` |
| Keyboard help, role picker, rest calendar shell | `board/KeymapHelp.ts`, `RolePopover.ts`, `RestPopover.ts` | `@ui-sdk/web/dialog` |
| Settings dropdown, Reader document menu | `board/workspace/SettingsMenu.ts`, `Reader.ts` | `@ui-sdk/web/popover` |
| View tabs, phone folio strip | `board/KanbanModal.ts`, `KanbanSurfaces.ts` | `@ui-sdk/web/tabs` |
| Dock Kind, Board grouping | `board/workspace/Dock.ts`, `Overview.ts` | `@ui-sdk/web/segmented-control` |
| Parent-fiber picker, Chronicle search | `board/workspace/Dock.ts`, `board/views/ChronicleView.ts` | `@ui-sdk/web/autocomplete` |
| Screen-reader announcements | `announce` callers across the board | core `announce` |
| Form dialog, parent picker, tag chips | `forms/AppDialog.tsx`, `forms/StashForm.tsx` | `@ui-sdk/react` dialog, autocomplete, combobox |

These stay the board's own, each for a reason that still holds:

- The Listen options menu holds a number field; an SDK menu closes on Tab and takes digits for typeahead.
- The sent-files sheet is a native `<dialog>` with its own Tab cycle and history entry; native `showModal()` makes the page inert but lets Tab leave for the browser's toolbar.
- The constitution picker filters from the bar's Find field, which every view shares; SDK autocomplete and command own their input.
- `selectPicker.ts` dresses a native `<select>` whose API the Dock uses throughout; the SDK select replaces the element.
- The banner is one inline `role=alert` line with two timings.
- Regions that are visible text as well as live regions (Dock save status, receipts, the aim readout) stay in place.
- Focus across a poll repaint is restored by identity (`DeskKeyboard.focusedRow()` and `refocus()`): renderers that rebuild with `innerHTML` have no per-row bindings for `createFocusRecovery`.
- Native radios in a `radiogroup` (the forms' kind control, the settings fieldsets) already have arrow keys and one tab stop.

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

`ui/test/setup.ts` supplies what jsdom lacks: popover, `inert`, `Element.animate`, scrolling, media queries, resize observers, `ElementInternals` form methods, and `CSS.supports` and `CSS.escape`.
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

## Popups from imperative code

When several openers share one popup, prefer `ui-popover-trigger for=<id>` with a payload: it gives Tab flow from trigger to content to the next control, toggling, ARIA and focus return. The Reader's document menu does this.
A popup opened through `api.open()` returns focus to whatever was focused before, so focus the opener first; it has no trigger, so cancel the `openchange` whose reason is `outside-press` and whose target is inside the anchor to let the anchor toggle it.
Content appended in the same task as `api.open()` measures normally, so a popup can be placed against its anchor before it opens.
To keep a full-screen scrim, make `ui-dialog-content` the scrim, close on a click whose target is the scrim, and set `initial-focus` to a selector.
A modal marks the deepest siblings along its path inert, not the board's root: test for `.kbn-desk` inside `[inert]`.
`api` is undefined on a disconnected element; setting `open`, `value` or `query` as a property fires no change event.

Popups pick up the browser's popover defaults: set `margin`, `padding` and `color` on the content, or item text is dark on the dark theme.
A popup stays mounted, inert but visible, until every transition in its subtree ends, so items carry no transitions unless the popup has an exit style.
SDK items are not buttons: `width: 100%` plus padding overflows.
`as-child` wrappers sit between a container and our buttons, so `button + button` and direct-child selectors do not match; `ui-tabs-tab` wraps a native button and carries `role="none"`.
A `ui-*-empty` part removes its children while there are results: put the message and its padding on one persistent child.
An autocomplete's `valuechange` reports the chosen item's `label`, not its `value`; repaint results from `valuechange`, not from an `input` listener.
Tabs and segmented controls fire `valuechange` from `api.select` and `api.setValue` only, not from setting `value`.

## Keys the board must give up

The board listens for keys on the document in the capture phase, so a bubbling `stopPropagation` in a popup cannot protect it.
`blockingDialogOpen()` in `board/views/ViewRegistry.ts` is the one guard: it matches open dialogs (SDK and native), open menus, and the board's own modal surfaces, and `handleKanbanKeyDown` returns early on it.
A new capture-phase handler yields the same way, and yields Escape to an expanded combobox, whose focus stays in its input.
Tablists receive only arrows, Home and End (`TABLIST_KEYS`); every other key on a focused tab is still the board's.

## Announcements

`announce` is for text nobody sees. All polite messages share one region, so a later message replaces an earlier one, and the text is written 100 ms after the call: tests under a paused clock advance it.
The region is real DOM text marked `data-ui-sdk-announcer`; gates that walk every text node skip it.

## Known SDK defects in this beta

- A popup opened from code ignores `final-focus` when it closes; see [the reproduction](ui-sdk-final-focus.md). Focus the opener before `api.open()`.
- The docs say setting `value` fires `valuechange` on tabs and segmented controls; it does not.
- Replacing an autocomplete's items inside an `input` listener registered before the element connects reverts the typed text.
- A combobox with `multiple` and `allowCustomValue` drops typed text when focus leaves.
- Positioning takes one scalar collision padding, with no boundary or per-edge value.
