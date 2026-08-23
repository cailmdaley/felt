# Plugin integration and releasing

felt ships a single plugin (`claude-plugin/`) that serves both **Claude Code**
and **Codex**. The same hook scripts and skills directory work for either agent;
only the manifest at the plugin root differs (`.claude-plugin/` and
`.codex-plugin/` siblings, same content). A single marketplace manifest at
`.claude-plugin/marketplace.json` registers the plugin for both.

- `felt setup claude` registers the `cailmdaley/felt` marketplace and installs
  the plugin through Claude's native CLI; `felt setup codex` does the same
  through Codex's native marketplace and plugin commands. Neither installer
  hand-writes harness configuration.
- The plugin bundles the `felt` and `shuttle` skills, a SessionStart hook (lists active +
  recently touched fibers), and a PreToolUse deny gate (`cmd/hook.go`).
  **Updating the binary updates hook behavior** — the plugin only needs
  refreshing when skill content changes.
- **Binary and plugin update in lockstep.** `felt update` swaps the binary then
  refreshes each integration; the Homebrew formula's `post_install` does the
  same on `brew upgrade felt`.

Every Claude/Codex setup source enters the same transaction. Remote GitHub refs
are first acquired into a disposable checkout; local `--source` paths enter
directly. Setup validates and copies only the complete marketplace payload into
`~/.felt/plugin-runtime/`, then promotes it under a cross-process lock with a
crash journal. Both manifests must describe the same version; the two skills,
hook manifest, executable hook files, and running felt executable's Shuttle
contract must all validate before the native CLI sees the candidate. Native
harness CLIs receive only the stable promoted `current` path and remain the
sole writers of their caches and configuration. If native installation reports
failure, setup restores both the last known-good staged generation and the
harness's previous marketplace/plugin state. The journal also records native
activation intent: after an interruption, the next setup restores `current`
first, reinstalls each affected harness from that path, verifies the restored
state, and retains the journal until reconciliation succeeds.

Every promoted plugin carries `.felt-generation.json` inside the payload the
harness copies. It binds the canonical local or GitHub source, requested ref,
resolved commit, plugin version, felt build identity, and a deterministic
payload digest. A same-version payload change is therefore a different
generation. The receipt recomputes the digest in both `current` and the loaded
harness cache and reports pending journals, missing markers, or identity
disagreement as unhealthy with a setup command to repair it.

Use `felt setup validate --source <checkout>` as the non-mutating candidate
gate. Use `felt setup receipt --json` after installation to report the bundle
the harness CLIs actually load, the resolved felt binary, hooks, and the live
daemon contract; incidental cache directories are not authoritative evidence.

Release: `scripts/release.sh <version>` bumps `claude-plugin/.claude-plugin/
plugin.json` and `.codex-plugin/plugin.json` in sync with the binary tag, then
`git push origin main v<version>` triggers the goreleaser workflow (darwin/linux
× amd64/arm64; auto-pushes the Homebrew formula). Before packaging, GoReleaser
runs the complete candidate validator and separately refuses manifests that do
not match the tag. The daemon artifact boot test also requires the structured
CLI/daemon contract receipt to be healthy.

Release candidates: `scripts/release.sh 1.1.0-rc.1` — any `X.Y.Z-<suffix>`
version cuts a prerelease. Three things then keep it away from everyone who
didn't ask for it, and all three key off the `-` in the tag: goreleaser marks
the GitHub release `prerelease: auto`; `install.sh` and `felt update` resolve
through the `releases/latest` API, which skips prereleases; and the Homebrew
tap's `skip_upload` is true for any prerelease, so `brew upgrade felt` never
sees it. The only way in is pinning `FELT_VERSION` (see [Release candidates](../shuttle/installation.md#release-candidates)). The daemon tarballs
attach to the RC release the same way, stamped with the RC version.
