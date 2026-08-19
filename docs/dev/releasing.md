# Plugin integration and releasing

felt ships a single plugin (`claude-plugin/`) that serves both **Claude Code**
and **Codex**. The same hook scripts and skills directory work for either agent;
only the manifest at the plugin root differs (`.claude-plugin/` and
`.codex-plugin/` siblings, same content). A single marketplace manifest at
`.claude-plugin/marketplace.json` registers the plugin for both.

- `felt setup claude` registers the `cailmdaley/felt` marketplace and installs
  the plugin; `felt setup codex` symlinks skills and configures Codex hooks.
- The plugin bundles the `felt` and `shuttle` skills, a SessionStart hook (lists active +
  recently touched fibers), and a PreToolUse deny gate (`cmd/hook.go`).
  **Updating the binary updates hook behavior** — the plugin only needs
  refreshing when skill content changes.
- **Binary and plugin update in lockstep.** `felt update` swaps the binary then
  refreshes each integration; the Homebrew formula's `post_install` does the
  same on `brew upgrade felt`.

Release: `scripts/release.sh <version>` bumps `claude-plugin/.claude-plugin/
plugin.json` and `.codex-plugin/plugin.json` in sync with the binary tag, then
`git push origin main v<version>` triggers the goreleaser workflow (darwin/linux
× amd64/arm64; auto-pushes the Homebrew formula). A `before`-hook guard refuses
to build a release whose manifests don't match the tag, so a forgotten bump
can't ship.

Release candidates: `scripts/release.sh 1.1.0-rc.1` — any `X.Y.Z-<suffix>`
version cuts a prerelease. Three things then keep it away from everyone who
didn't ask for it, and all three key off the `-` in the tag: goreleaser marks
the GitHub release `prerelease: auto`; `install.sh` and `felt update` resolve
through the `releases/latest` API, which skips prereleases; and the Homebrew
tap's `skip_upload` is true for any prerelease, so `brew upgrade felt` never
sees it. The only way in is pinning `FELT_VERSION` (see [Release candidates](../shuttle/installation.md#release-candidates)). The daemon tarballs
attach to the RC release the same way, stamped with the RC version.
