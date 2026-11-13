# Menu final-focus reproduction

UI SDK 0.1.0-beta.1 returns focus to `body`, rather than the `final-focus` target, when this controller-opened menu closes with Escape.
I reproduced this in headless Chrome with the installed packages, without application teardown or board keyboard handlers.
This is an SDK bug report, not an expected board behaviour.

Run this in a page whose bundler resolves the installed package:

```ts
import '@ui-sdk/web/menu'

const target = document.createElement('button')
target.id = 'return-here'
target.textContent = 'Return here'
document.body.append(target)
const menu = document.createElement('ui-menu')
menu.setAttribute('modal', 'false')
const content = document.createElement('ui-menu-content')
content.setAttribute('final-focus', '#return-here')
const item = document.createElement('ui-menu-item')
item.textContent = 'Alpha'
content.append(item)
menu.append(content)
document.body.append(menu)
void menu.api.open({ anchor: target, focus: 'first' })
```

Wait for Alpha to receive focus, then press Escape.
Expected: `document.activeElement === target`.
Observed: `document.activeElement === document.body`.
The menu remains connected, so application removal isn't responsible.
Focusing `target` before opening makes the controller's previous-focus fallback work.
