# Cross-project stores

A cross-project store gathers many projects' fiber trees into one searchable, linkable body of knowledge; each project's `.felt/` is joined to it by a symlink. The full story — motivation, views, links, the shuttle daemon — is at https://cailmdaley.github.io/felt/concepts/cross-project/.

## Views

When a project's `.felt/` is a symlink into the store, felt run there sees a view: `ls` and `tree` stay in the project under short ids, `find` searches the whole store, and full store ids work in `show`, `edit`, `nest` and `rm`. Links like `[[other-project/slug]]` resolve and pass `felt check`. A link into a store joined by no symlink cannot resolve; the warning is accurate.

## Direction

- **Store canonical** (real files in `~/store/.felt/<project>/`, project `.felt` symlinks in): the default. The project gets the view behaviour above.
- **Project canonical** (real files in `<project>/.felt/`, store symlinks in): when the project has its own git remote, a folder-scoped sync (iCloud, Dropbox), or content that must stay out of the store's history. The project side then sees only itself; use `felt -C ~/store` for cross-project work.

## Linking without losing fibers

`ln -s` over an existing `.felt/` fails or silently replaces it.

1. `ls` both ends. If both hold fibers, merge into the canonical side first, deciding every name collision by hand.
2. Move the side that becomes the symlink aside: `mv <project>/.felt <project>/.felt.pre-link`.
3. Link: `ln -s ~/store/.felt/<project> <project>/.felt` (reverse the arguments for project canonical).
4. Verify: `felt -C <project> ls -s all` and `felt -C ~/store tree` show the expected fibers.
5. Only then `rm -rf` the backup. Ask before deleting anything that did not verify.
