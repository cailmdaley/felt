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

## Rex

For a Rex-held worker, `shuttle attach <fiber>` asks the local daemon to select the worker in the Rex app; it does not render the worker in the calling TTY.
A tmux-held worker attaches in the calling TTY, including on a Rex-configured host.
The board opens local Rex workers in the app and opens local or remote tmux workers in Rex viewer windows, using SSH for remote tmux.
Workers and viewers share a session for their constitution family, even when its root has no live worker.
Each worker has one tab, labelled with its fiber leaf and indented by constitution depth; remote viewer tabs also show ` @host`.
Opening selects both the family's session and the worker's window.
For a worker held by another host's Rex server, first choose **Add Remote Host…** in the Rex app and enter `http://<owner>.<tailnet>:7297`; the owner then selects the worker in that attached client.
[Installation](installation.md#rex-terminal-backend) covers the required app settings and privacy grant.

## Kitty

On tmux-configured hosts, Kitty is the board's automatic terminal opener on macOS and Linux.
Other terminals can run `shuttle attach <fiber>` for tmux workers; Kitty is not required for that command.

The opener runs on the machine whose daemon serves the board, not automatically on the machine running your browser.
For example, open your laptop's board to have a click raise your laptop's Kitty and attach to a remote worker over SSH.
Opening a remote server's board directly doesn't give that server access to your laptop's terminal.

Install [Kitty](https://sw.kovidgoyal.net/kitty/) and add these lines to `~/.config/kitty/kitty.conf`:

```conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty
```

Reopen Kitty to apply them.
The socket lets Shuttle find and control a running Kitty window; this is [Kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/), separate from Claude's Remote Control.
Shuttle can also open a new Kitty window when no live control socket exists.

On macOS, start Kitty normally from the Dock or Finder before letting it create the tmux server.
You can seed the server in that window:

```sh
tmux new-session -d -s shuttle-anchor
```

An existing server needn't be replaced.
Starting it through a launcher's hotkey panel can give workers the launcher's privacy permissions instead of the terminal's.
A quick-access panel is fine for **attaching** to a server already started normally.

For a remote terminal, configure an SSH destination even if the fleet API uses Tailscale; see [Connect your machines](remotes.md#personal-machines-with-tailscale).

### Quick-access terminal

Kitty's [quick-access terminal](https://sw.kovidgoyal.net/kitty/kittens/quick-access-terminal/) is a convenient way to bring the worker into view with a hotkey.
It requires a Kitty version that provides `kitten quick-access-terminal` (0.42 or newer).
Add this to `~/.config/kitty/quick-access-terminal.conf`:

```conf
kitty_override allow_remote_control=socket-only
kitty_override listen_on=unix:/tmp/kitty
```

Run `kitten quick-access-terminal` to toggle the panel.
On macOS, initialize it from Kitty, then assign a shortcut to **Quick access to kitty** in Keyboard Shortcuts → Services.
On Linux, bind that command in your desktop or window manager.
Shuttle prefers a live quick-access panel when opening a worker terminal.

## Claude Remote Control

Enable Remote Control on the machine running Claude, using your signed-in Claude session.
For an existing worker, attach to it and run `/remote-control`.
To enable it for future interactive sessions, use Claude's `/config` and turn on **Enable Remote Control for all sessions**.
Complete Claude's confirmation and verify that the session reports a connected link.
Account and organization requirements are documented in [Claude's Remote Control guide](https://code.claude.com/docs/en/remote-control).

Shuttle reads that link from the session's transcript; it does not turn Remote Control on just because you chose a browser or app opener.
Browser opening uses the recorded `claude.ai` URL.
App opening uses the Claude URL handler, so the Claude app must be installed and able to handle it; use the browser option if that handler isn't available.

Remote Control isn't needed for tmux attachment or for the Shuttle board itself.
The Claude process and its host must remain running whichever view you use.

## Check the chosen route

Use a disposable task and click its worker control.
For Kitty, confirm you reach the existing tmux conversation and can detach without stopping it.
For Rex, confirm the app selects the worker's window.
For Claude, confirm the browser or app shows that same conversation with a connected Remote Control session.
A window opening is only the first half of the check.
