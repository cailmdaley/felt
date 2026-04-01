---
title: tapestry_nodes in astra.yaml
tags:
    - decision
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:28:58.921106+02:00
outcome: 'Decision→evidence mapping defined declaratively in astra.yaml via new tapestry_nodes field per decision (list of specNames). Keeps mapping version-controlled in the spec rather than scattered across fiber tags. Alternative: evidence:{decision_id} tags on fiber files (rejected for KineLens — .felt/ is a broken symlink to remote machine). Fallback: felt export still checks evidence: tags if tapestry_nodes absent.'
---

(tapestry-nodes-in-astra-yaml)=
# tapestry_nodes in astra.yaml
