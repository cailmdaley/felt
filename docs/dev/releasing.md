# Plugin integration and releasing

felt ships one shared plugin payload (`claude-plugin/`) for **Claude Code** and
**Codex**, plus a native package for **pi**. The same hook scripts and skills
directory work for Claude and Codex; only the manifest at the plugin root
differs (`.claude-plugin/` and `.codex-plugin/` siblings, same content). A
single marketplace manifest at `.claude-plugin/marketplace.json` registers the
shared plugin for both.

- `felt setup claude` registers the `cailmdaley/felt` marketplace and installs
  the plugin through Claude's native CLI; `felt setup codex` does the same
  through Codex's native marketplace and plugin commands. Neither installer
  hand-writes harness configuration.
- `felt setup pi` installs the same skills plus the pi extension through pi's
  package manager. `felt update` refreshes pi only when the Felt package is
  already registered, so an update never opts a new harness into the
  integration.
- The plugin bundles the `felt` and `shuttle` skills, a SessionStart hook (lists active +
  recently touched fibers), and a PreToolUse deny gate (`cmd/hook.go`).
  **Updating the binary updates hook behavior** — the plugin only needs
  refreshing when skill content changes.
- **Binary and plugin update in lockstep.** `felt update` swaps the binary then
  refreshes each installed integration; the Homebrew formula's `post_install`
  does the same on `brew upgrade felt`.

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
harness's previous marketplace/plugin state. A zero exit status alone never
commits a promotion: before the journal records `committed` and `previous` is
discarded, setup reads the cache path each native CLI reports as loaded
(`plugin list --json`), recomputes its payload digest, and requires it to
carry the promoted generation marker. A failed verify first gets one forced
reinstall (uninstall+install / remove+add), because `plugin update` on an
unchanged manifest version legitimately keeps the old versioned cache; a
cache that still cannot prove the promoted generation after that is a
rejected candidate — the filesystem rolls back and the prior native state is
restored. The journal also records native
activation intent: after an interruption, the next setup restores `current`
first, reinstalls each affected harness from that path, verifies the restored
state, and retains the journal until reconciliation succeeds.

Every promoted plugin carries `.felt-generation.json` inside the payload the
harness copies. It binds the canonical local or GitHub source, requested ref,
resolved commit, plugin version, felt build identity, and a deterministic
payload digest. A same-version payload change is therefore a different
generation. The receipt recomputes the digest in both `current` and the loaded
harness cache and reports pending journals, missing markers, or identity
disagreement as unhealthy with a setup command to repair it. The receipt also
binds the marker's felt build to the resolved executable it is diagnosing: a
promotion sealed by a different felt build reports mismatch even when source
and caches agree with each other. Marker and journal writes are fsynced and
renamed with a parent-directory sync, so the recovery guarantees hold across
power loss, not only process death.

Use `felt setup validate --source <checkout>` as the non-mutating candidate
gate. Use `felt setup receipt --json` after installation to report the bundle
the harness CLIs actually load, the resolved felt binary, hooks, and the live
daemon contract; incidental cache directories are not authoritative evidence.

CI is a release gate as well as a pull-request check. The UI job runs
`npm test`, which executes the board suite twice under the pinned
`America/Los_Angeles` and `Europe/Paris` timezones, and then runs the
production bundle build. A green Go and daemon suite without this UI test is
not a release-ready result.

Release: `scripts/release.sh <version>` first requires the main checkout to be
cleanly aligned with `origin/main` and checks that the new tag is absent both
locally and remotely. It then bumps
`claude-plugin/.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json` in sync with the binary tag, commits that bump, and
creates the annotated tag. The script prints the explicit
`git push origin main v<version>` command; it does not push for you.

Pushing the tag triggers the GoReleaser workflow (darwin/linux ×
amd64/arm64; it updates the Homebrew formula for final public releases). The
workflow pins GoReleaser to the version used for the published 1.1.0-rc.3
assets. Before packaging, GoReleaser runs the complete candidate validator,
requires the two plugin manifests to agree, and on a real tag refuses a
manifest version that does not match it. Local snapshots skip only the tag
comparison, which keeps development packaging usable while retaining the
agreement check. GoReleaser creates a draft release and defers the Homebrew
tap update; the daemon matrix
boot-tests every native artifact, attaches all four daemon tarballs, and the
final job verifies the complete eight-archive set before making the release
public. GoReleaser's formula is preserved as an Actions artifact alongside
those exact archives; for a final release, that job pushes the preserved file
to the tap through the GitHub Contents API only after publication. A failed
native platform therefore leaves a
draft for repair instead of exposing a stable CLI release that cannot satisfy
`SHUTTLE=1` installs; a tap update cannot point at draft assets either.
Rerunning the same tag reuses that draft and replaces its artifacts.

The tap currently publishes a Homebrew **Formula**, so keep using
`brew install cailmdaley/tap/felt`. GoReleaser reports the legacy `brews`
publisher as deprecated in current v2 releases; moving to `homebrew_casks`
would require a coordinated tap and documentation migration and is tracked as
a packaging follow-up rather than being mixed into a stable release cut.

For an end-to-end binary consumer check, use an explicit published tag in a
fresh home directory and inspect both installed versions before starting the
daemon:

```bash
PROBE_ROOT="$(mktemp -d)"
HOME="$PROBE_ROOT/felt-home" PATH=/usr/bin:/bin \
  FELT_INSTALL_DIR="$PROBE_ROOT/felt-bin" \
  FELT_VERSION=1.1.0-rc.3 SHUTTLE=1 \
  SHUTTLE_HOME="$PROBE_ROOT/shuttle" sh ./install.sh
"$PROBE_ROOT/felt-bin/felt" --version
"$PROBE_ROOT/shuttle/bin/shuttled" version
```

The installer verifies those version identities before replacing an existing
binary or daemon tree. The native release matrix boots each assembled daemon
artifact before upload, while the Linux container acceptance harness builds
from a clean image and polls `/api/v1/version` until its contract is healthy.

Release candidates: `scripts/release.sh 1.1.0-rc.1` — any `X.Y.Z-<suffix>`
version cuts a prerelease. Three things then keep it away from everyone who
didn't ask for it, and all three key off the `-` in the tag: goreleaser marks
the GitHub release `prerelease: auto`; `install.sh` and `felt update` resolve
through the `releases/latest` API, which skips prereleases; and the Homebrew
tap's `skip_upload` is true for any prerelease, so `brew upgrade felt` never
sees it. The only way in is pinning `FELT_VERSION` (see [Release candidates](../shuttle/installation.md#release-candidates)). The daemon tarballs
attach to the RC release the same way, stamped with the RC version.
