name: "Meeting-to-ASTRA interface"
description: Design and implementation of Portolan's live meeting pipeline — from transcript to ASTRA-structured research record.
---

# Meeting-to-ASTRA interface

A workflow where live or near-live meeting audio is transcribed locally, diarized by speaker, segmented into research events, and formalized into felt/ASTRA structures as the conversation unfolds.

## Design principles

**Recording-first, retrieval-first, human-gated.** The smallest honest pilot uses local ASR + diarization to produce a reviewed queue of candidate decisions, questions, action items, and plot requests. The primary meeting affordance is pulling existing plots, artifacts, and evidence into the conversation — retrieval over prior work, not latency-optimized autonomous analysis.

**The transcript is the exploratory substrate.** Candidate events are the routing layer; fibers are the durable unit of concern; ASTRA structure emerges through progressive consolidation rather than being imposed on every utterance.

## What we built (22 fibers under the meeting constitution)

### Ingress

- **HTTP transcript ingress** — VoiceInk or other ASR tools POST transcript segments to Portolan's `/meeting/transcript` endpoint
- **VoiceInk live partial streaming** — investigated real-time partial transcript capture; cleaner on NVIDIA/Linux than macOS currently
- **Manual ingress surface** — fallback for pasting or uploading transcript text directly

### Live document

- **Live brief surface** — MeetingBridge generates a continuously-updated `meeting-live-brief.md` beside `meeting.json`, making the active meeting a renderable document rather than HUD-only state
- **Live document navigation** — Markdown file links for retrieved evidence, promoted fibers, and per-run provenance logs; the markdown viewer intercepts file-path links and opens them inside Portolan
- **Project-local meeting live** — Prefers a project-local `meeting-live-brief.md` beside `astra.yaml` when the worker city path exists

### ASTRA integration

- **Live ASTRA lane** — MeetingBridge continuously syncs the active live brief into `astra.yaml` as a dedicated meeting analysis lane, distinct from explicit promotion
- **Live ASTRA structure** — Retrieval queue and assistant reply sections written into the live meeting document; assistant/retrieval logs included in ASTRA provenance
- **Meeting brief ASTRA promotion** — Accepted briefs promoted into `astra.yaml` as stable sub-analyses with meeting provenance, transcript/evidence inputs, accepted-note findings, and decisions

### Candidate events

- **Candidate event capture** — Transcript parsed for research-relevant events: decisions, questions, action items, plot requests
- **Candidate provenance** — Selection and validation of provenance for each candidate
- **Candidate felt promotion** — Accepted candidates promoted to felt fibers
- **Decision ASTRA promotion** — Accepted decisions promoted with full ASTRA structure

### Retrieval and evidence

- **Retrieval surface** — Search and present existing analysis artifacts during meetings
- **Retrieval evidence capture** — Evidence retrieved during meetings captured with provenance
- **Meeting bridge provenance** — Recovery and HUD log access for provenance chains

### Operator and narrative

- **Live operator corrections** — Human corrections to transcript, speaker attribution, and candidate events
- **Live narrative surface** — Running narrative synthesis from accepted meeting events
- **Live assistant egress** — Hook for assistant responses to flow back to the meeting interface

### WebSocket and HUD

- **WebSocket state** — Meeting state broadcast to connected browsers
- **HUD meeting bridge surface** — Meeting controls and status in Portolan's city HUD

## The pipeline

```
Audio → ASR (VoiceInk) → POST /meeting/transcript
  → MeetingBridge parses candidates
  → Human reviews/accepts in HUD
  → Accepted items → felt fibers + ASTRA promotion
  → Live brief continuously updated
  → ASTRA lane synced to astra.yaml
```

## Open questions

- What is the best local ASR + diarization stack for recordings first, and for true streaming later?
- How should previously computed artifacts be indexed so that spoken requests can reliably retrieve the right plot, table, or evidence chain?
- What error rates are tolerable in each lane, and where must human confirmation be mandatory?
- How should agent roles split between transcript parsing, action-item capture, evidence retrieval, and live computation?
