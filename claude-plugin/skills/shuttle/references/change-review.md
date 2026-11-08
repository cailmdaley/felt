# Preparing a change for review

Before a branch becomes a PR, bake it into a change the human can read on the board. The reader shows your story first, then tests, then every changed line you left out, and their comments come back to you as one message. They open the PR when they are happy with it, not before. The bundle format and the CLI are in the [changes concept](https://cailmdaley.github.io/felt/concepts/changes/). Where your store has a practice for taking a feature to a PR, it holds the judgment; this page holds the mechanics.

## The pass

1. **Clean the branch.** Commits read in order, tests pass, nothing stray. Rebase on the base first.
2. **Bake and write the story.** Write `story.json` beside your fiber and iterate with `shuttle change <fiber> --base origin/main --story story.json --check`.
3. **Get flags from someone else.** A fresh reviewer of another model family reads the diff, not your story's conclusions, and names up to three places worth the human's eyes: what they would want to weigh in on, not a list of possible attacks. Their flags go in the story's `flags`.
4. **Fix what the review found,** then rebake.
5. **Ask.** `shuttle change <fiber> --base origin/main --story story.json`, then `shuttle ask` naming what you want their view on. Link the bundle from the tapestry with a relative link.
6. **Absorb the comments.** Each arrives anchored `path:line` against a head SHA. Comments are the human's words, so answer them in the conversation, change the code, and rebake.
7. **Open the PR only when they say so.** The story's overview and chapters are the raw material for the body, which is written for its own cold reader.

## A story worth reading

Name `areas` by concept, explaining where the change sits, its parts and what it adds, for a reader who has never seen the code.

- **Tell what the change is.** What it adds, how it's meant to be used, how the parts fit. A reader finishes knowing the feature, not the bugs you fixed on the way.
- **Order by understanding, not by file tree.** Each chapter's `why_here` says why it comes at that point.
- **Stops are short.** The lines that carry the meaning, usually under 40. A new file gets several stops in reading order, or one, never the whole file. Anything you leave out stays in Remaining, on purpose.
- **Three to five chapters, a handful of stops.** The story should take five minutes. If it can't, the change may want splitting.
- **Plain language.** Say what the code does and why.
- **Leave tests out.** They have their own lane.

`shuttle change` reports how many changed lines the story shows. A low number is fine, and a story that shows everything is usually a story that chose nothing. Nothing can hide: every changed line appears in Story, Tests or Remaining.

The reader opens version 2 bundles; rebake an older companion with `shuttle change`.

For a repo that lands directly on `main`, such as felt, the same pass works on commits already landed, or on a branch just before landing. A change never needs a PR.
