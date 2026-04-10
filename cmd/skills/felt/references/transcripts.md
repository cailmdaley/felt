# Transcript Processing

Turn a raw transcript into useful content: a notes document that stands alone, then fiber extraction for anything that enters the DAG.

**Review required.** You weren't there — present the plan, get approval, then proceed.

---

## Phase 1: Notes Document

The notes document is the primary output. It should be readable by someone who wasn't in the meeting and leave them confident they know what happened, what was decided, and what's expected of them.

### 1. Read and Segment

Read the transcript end-to-end. Segment by topic, not by speaker or chronology. Conversations jump around — reorganize into coherent threads. For each topic, classify:

- **Information** — shared for awareness, no action needed
- **Discussion** — explored but not resolved this meeting
- **Decision** — a conclusion was reached

This classification drives what the notes emphasize.

### 2. Draft the Notes

Structure:

```markdown
# [Meeting title] — [Date]

**Attendees:** [names]
**Purpose:** [one sentence]

## Summary

[2-4 sentences. What was this meeting about and what came out of it?
Lead with the most consequential outcome. Write for the person
who will skim only this paragraph.]

## Topics

### [Topic name]

[Discussion summary — what was explored, what considerations arose.
2-4 sentences per topic. Capture the trajectory: how the group moved
from uncertainty to conclusion, not who said what to whom.]

**Decision:** [if any — state clearly what was decided and why]

### [Next topic]
...

## Action Items

| Who | What | When |
|-----|------|------|
| [single person] | [specific deliverable] | [date or TBD] |

## Parking Lot

- [Issues raised but not resolved — prevents good ideas from vanishing]

## Open Questions

- [Things that need answers before next steps can proceed]
```

### Principles

**Write for the absent reader.** They should understand what happened, know what's expected of them, and not be blindsided by missing context.

**Record what was decided, not who said what.** Attribution only for: action item owners, presenters, and formal proposals. "Concerns were raised about X" not "Alice said she was worried about X." Reducing attribution encourages candor and keeps notes lean.

**Preserve reasoning, not debate.** For non-obvious decisions, capture the key factors that tipped the conclusion — not the back-and-forth. "Chose X over Y because Z" is sufficient.

**Decisions get their own line.** Always labeled `**Decision:**` so they're scannable. Include rationale briefly. If there was meaningful dissent on a consequential matter, note the position (not the person).

**Action items are atomic.** One owner (never "the team"), one deliverable, one deadline. If the deadline wasn't stated, write "TBD — needs confirmation." Implicit commitments count — "I'll send that over" is an action item even without a due date.

**The parking lot is a first-class section.** Topics raised but tabled, ideas that surfaced in tangents, things someone should follow up on but that weren't assigned. These are where untracked work hides.

**Compress aggressively.** A 60-minute transcript is ~10,000 words. Good notes are 500-1,000. Cut: filler, false starts, repetition, procedural back-and-forth, small talk, information already in pre-reads. Keep: specific numbers, dates, commitments, the emotional temperature of important moments.

**Tone shifts signal importance.** When the conversation's energy changes — someone gets animated, the room goes quiet, a joke lands that's actually about a real tension — note the substance, not the drama.

### 3. Review Notes with User

Present the draft. They may restructure, cut, or add context you couldn't infer. The notes document is the artifact — get it right before moving to extraction.

---

## Phase 2: Fiber Extraction

The notes document already contains decisions, action items, and open questions. Phase 2 asks: which of these belong in the DAG, and what did the notes miss?

### 4. Identify Fiber Candidates

Walk the notes and flag anything that should persist beyond the meeting:

- **Decisions** already labeled in the notes — these are the primary candidates
- **Action items** that represent real work (not just "send the slides")
- **Open questions** that need their own investigation
- **Parking lot items** that deserve tracking

Then re-scan the transcript for **implicit content** the notes compressed away:
- Ideas buried in problems ("This keeps breaking because..." -> idea for better approach)
- Philosophy as aside ("I always think you should..." -> principle)
- Decisions by omission ("We could do X but..." [moves on] -> decided NOT to)

### 5. Review and File

Present the extraction plan, split by relevance:

```
Probably file:
- Decision: Chose algorithm X because Y
- Open question: Whether sigma_8 tension is real

Probably skip:
- Action item for [other person] — not our tracking scope
- Status update — ephemeral
```

**Wait for approval.** Then file:

```bash
felt add algorithm-x-choice "Decision: Use algorithm X" \
  -o "Meeting YYYY-MM-DD. Compared X vs Y. X chosen because faster convergence; Y failed benchmarks."
```

Update existing fibers when the meeting produced status on tracked work:
```bash
felt edit <id> -s closed -o "Resolved in meeting: decided to use Z because..."
# for narrative updates, edit .felt/<path>/<slug>.md directly and add wikilinks/body text there
```

Link new fibers to related ones:
```bash
felt ls -s all "related concept"
felt tree
```

Big decisions may also warrant updating CLAUDE.md or documentation fibers.

---

## Quality Checklist

- [ ] Transcript read end-to-end
- [ ] Topics segmented and classified (information / discussion / decision)
- [ ] Notes document drafted and reviewed with user
- [ ] Fiber candidates identified (from notes + implicit content re-scan)
- [ ] Extraction plan approved before filing
- [ ] Outcomes stand alone without the body
- [ ] New fibers connected through containment, wikilinks, or ASTRA data flow
