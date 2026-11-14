# Preparing a change for review

The story is the PR body: one text for the board and GitHub, opening on what the change produces and what most needs the human's judgment.
The reader shows that story, with code folded until requested, then tests and the changed lines you left out.
Comments come back to the worker as one message.
The human can look before you have done any of this: every constitution with a `project_dir` has a Change page on the board, which bakes the checked-out branch as it stands, uncommitted work included, each time it is opened.
The [changes concept](https://cailmdaley.github.io/felt/concepts/changes/) documents the CLI and bundle format.
A store's review practice holds the project's judgment; this page holds the pass and its mechanics.

## The pass

1. **Review the change against the principles and fix what you find.** This is the code review; it comes before any story.
   - **As simple as possible.** Could it do the same with fewer parts, options or layers?
   - **Integrated, not stapled on.** An addition reshapes the existing design as if it had always been there, rather than sitting beside it.
   - **Existing code used.** No second helper for something the codebase already does.
   - **A small diff.** Nothing unrelated rides along.
   - **A clear design.** Someone new to the code can say what each part is for.

   Commits read in order and tests pass.
2. **Get an independent review.** A fresh reviewer of another model family reads the diff against those principles, not your story's conclusions.
   Fix what they find.
   Keep up to three facts needing the human's judgment in `flags`, including merge-time facts that the diff cannot show.
3. **Write the story and open the PR.** Use the overview, flags and chapter narratives as the PR body, preserving their Markdown and Mermaid source rather than writing another account.
   Open the PR as soon as the pass is done; there is no waiting for the human to authorize opening it.
4. **Bake the PR.** Write the story beside the fiber as `pr-N.story.json`, then run `shuttle change <fiber> --pr N --story pr-N.story.json`.
   The CLI fetches the PR's exact head and its own base branch, including stacked PRs, and writes `pr-N.change.json`.
   The bundle appears in the fiber's sends by title, branch and line counts.
   Name the PR in the constitution too (`shuttle.change.prs: [N]`), and its Change page bakes that PR with this story on every opening; a card that follows several PRs lists them there.
   A relative link from a tapestry opens it too.
5. **Absorb the comments.** Each code comment names a `path:line` against a head SHA.
   Answer in the conversation, change the code and update the same story and PR body.
   Rebake with `shuttle change <fiber> --pr N`; the sidecar story is applied automatically.

For a repository that lands directly on `main`, the same pass works on a branch before landing or on committed changes.
Use `shuttle change <fiber> --base origin/main --story <name>.story.json --name <name>`; a change doesn't need a PR.
The reader opens version 2 bundles.

## A story worth reading

- **Open on the result and the judgment.** Say what this change produces, who uses it and what the human most needs to weigh.
  The flags open the story, alongside the overview.
- **Use the same text in the PR.** The overview and chapter narratives should stand alone for someone who hasn't followed the work.
  Keep the PR body and the story in agreement as the branch moves.
- **Draw structure.** Fenced `mermaid` diagrams render in both the reader and GitHub.
  Use a flowchart for relationships or a sequence diagram for a handoff when it explains more quickly than prose.
- **Order by understanding.** Chapters follow the explanation, not the file tree.
  Each `why_here` explains the order; conceptual `areas` name the parts for someone new to the code.
- **Use stops only when the code itself needs looking at.** A stop shows its note and `file:lines`; clicking opens the code.
  Keep chosen ranges short, usually under 40 lines.
  Never stop on documentation or a README: tell the reader the point in the story instead.
  Tests have their own lane.
- **Choose rather than exhaust.** A few chapters and a handful of stops should take about five minutes.
  A chapter can explain a change without any stops.
  Leave supporting machinery to Remaining on purpose.

`shuttle change <fiber> --pr N --check` reports changed-line coverage and stale stops without writing either the bundle or its sidecar.
Coverage is an honesty check, not a target.
A stop whose file or diff range no longer exists remains visible with a stale reason; a normal bake still succeeds.
Repair those references while iterating, and use `--story path` to replace the sidecar deliberately.
