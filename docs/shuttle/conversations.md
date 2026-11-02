# Opening conversations

A worker keeps running where Shuttle launched it.
Opening its conversation gives you another view of that work; it doesn't move the process to your laptop, browser, or phone.
A live worker's pill names its turn (**question**, **idle**, **blocked**, **working**, **starting**, **no signal**) and opens the terminal that owns it.

## Supported routes

| Worker | Runs in | Open it with |
|---|---|---|
| Claude Code | Selected host's tmux or Rex backend | `shuttle attach` or the board's terminal opener; Claude browser/app when Remote Control has connected. |
| Codex | Selected host's tmux or Rex backend | `shuttle attach` or the board's terminal opener. |
| Pi | Selected host's tmux or Rex backend | `shuttle attach` or the board's terminal opener. |

## Choose where conversations open

The constitution header shows **Console** whenever the worker has a destination on your device, including phones.
Tap Console or a worker pill to open the remembered destination.
Long-press or right-click either control to pick from all available destinations, even when there is only one.
The check mark identifies the destination a tap uses.

The board remembers terminal, Claude browser, and Claude app preferences in this browser.
A terminal worker opens through the selected host's terminal backend; a Rex worker opens in Rex, while a tmux worker attaches in the calling terminal.
On a phone, the board uses a Claude web link when Remote Control has connected and otherwise shows the worker without a remote destination.
