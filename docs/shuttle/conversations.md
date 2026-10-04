# Opening conversations

A worker keeps running where Shuttle launched it.
Opening its conversation gives you another view of that work; it doesn't move the process to your laptop, browser, or phone.
The **Aloft**, **Waiting**, and **Needs you** controls on a card all open that worker.

## Supported routes

| Worker | Runs in | Open it with |
|---|---|---|
| Claude Code, terminal surface | tmux on the selected host | Any terminal with `shuttle attach`; Kitty from the board; Claude browser/app when Remote Control has connected. |
| Codex, terminal surface | tmux on the selected host | Any terminal with `shuttle attach`; Kitty from the board. |
| Codex, app surface | The selected host's native Codex App Server | The desktop conversation link; native remote access on another device. |
| Pi | tmux on the selected host | Any terminal with `shuttle attach`; Kitty from the board. |

New Codex tasks default to the app surface.
Choose `--surface cli` when installing a Codex task if you want a terminal worker instead.
Changing an opening preference doesn't change a task's execution surface.

## Choose where Claude opens

Settings opens to **Conversations**, with **Open conversations in** at the top.
Choose the default for Claude sessions: **Terminal**, **Claude browser**, or **Claude app**.
The choice saves immediately.
Right-click **Aloft** to use another available route for that conversation without changing the default.
This is a preference for the browser you're using, separate from the host configuration selected in Settings.
Claude browser/app routes require a recorded Remote Control link for that session.
The preference doesn't enable Remote Control by itself.
If the link is missing on desktop, the control says **terminal** and falls back to Kitty; History explains that Remote Control is needed.
A valid browser link without a supported desktop-app route opens in the browser and is labelled **browser**.

On a phone, Shuttle uses the available conversation link because there is no local terminal to raise.
Codex app workers keep their own native opening route.
A mobile Codex link opens ChatGPT; use **Remote**, select the host and project, then choose the conversation.
It is not a guaranteed conversation-specific mobile deep link.

## Kitty

Kitty is the supported terminal for the board's automatic terminal opener on macOS and Linux.
Other terminals can still run `shuttle attach <fiber>`; Kitty is not required for that command.
To request another board terminal integration, [open an issue](https://github.com/cailmdaley/felt/issues/new) naming your terminal and operating system.

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

## Codex desktop and remote access

App-surface workers need Shuttle and the desktop app to reach the same native backend.
A directory containing Codex transcripts alone does not provide that connection.
The [Codex desktop setup](codex-desktop.md) walks through the explicit bridge on macOS and verifies that both interfaces continue the same conversation.

Using that conversation from another device additionally requires native Codex remote access to be enabled and connected.
Follow the [official remote-connections guide](https://learn.chatgpt.com/docs/remote-connections) for your installed app, then test the actual conversation from the second device.
Local backend connectivity, an opening link, and remote access are three separate things to verify.

## Check the chosen route

Use a disposable task and click its worker control.
For Kitty, confirm you reach the existing tmux conversation and can detach without stopping it.
For Claude, confirm the browser or app shows that same conversation with a connected Remote Control session.
For Codex app workers, confirm the desktop and any remote device can continue the same thread.
A window opening is only the first half of the check.
