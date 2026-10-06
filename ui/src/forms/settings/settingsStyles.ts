/**
 * The settings sheet's chrome, as one idempotent stylesheet.
 *
 * It speaks the forms' stock from the palette (`--kbn-form-paper`, the
 * `--kbn-form-band` header, brass `--kbn-owed-bright`, graphite ink and
 * hairlines), because it lives inside `AppDialog` alongside Stash and Capture
 * and those three have to look like one kit.
 *
 * **What it does NOT spend colour on.** The board's four pigments are claims
 * about work — who acted, what is owed, what was judged. Configuration is
 * machinery, so almost everything here is iron gall. The two exceptions each
 * earn their hue from the board's own grammar: a remote that has gone stale
 * takes gold, because gold is what the board already means by "attend to this
 * now", and a refusal takes the forms' error red. There is deliberately no
 * green anywhere: a healthy remote is drawn by the absence of a mark, not by a
 * dot claiming everything is fine.
 *
 * Injected by element id on first render, like every form sheet.
 */

import { injectStyles } from '../injectStyles'

export function injectSettingsStyles(): void {
  injectStyles('shuttle-settings-styles', SHEET)
}

const SHEET = `
/* ── The page ──────────────────────────────────────────────────────────── */

.set-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  width: 100%;
  font-family: var(--font-main, 'EB Garamond', serif);
  color: var(--kbn-graphite);
}

/* Which host this whole page is about. A full-width band above the rail and
   the pane rather than a control inside one of them, because it scopes both:
   every read and every write below it is addressed to this host, and a page
   that can write another machine's configuration should never make you look
   for which machine that is. */
.set-hostbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 22px;
  background: var(--kbn-form-well);
  border-bottom: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
}
.set-hostbar-label {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--kbn-graphite-faint);
  flex: 0 0 auto;
}
.set-hostbar-note {
  font-size: 13px;
  color: var(--kbn-graphite-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.set-hostbar-stale {
  color: var(--kbn-owed-deep);
}

.set-cols {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.set-done { margin-left: auto; }
.set-discard, .set-notice {
  padding: 12px 16px;
  background: color-mix(in srgb, var(--kbn-owed-bright) 9%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--kbn-owed) 30%, transparent);
  font-size: 14px;
  line-height: 1.45;
}
.set-discard { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.set-discard > span { flex: 1 1 16rem; }
.set-notice { margin-bottom: 16px; border: 1px solid color-mix(in srgb, var(--kbn-owed) 30%, transparent); border-radius: 3px; }
.set-notice p { margin: 6px 0 0; overflow-wrap: anywhere; }

/* ── The rail ──────────────────────────────────────────────────────────── */

.set-rail {
  flex: 0 0 auto;
  width: 11rem;
  padding: 12px 0 12px 12px;
  border-right: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}
.set-railbtn {
  appearance: none;
  background: none;
  border: none;
  border-radius: 3px;
  margin: 0;
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  font-family: var(--font-main, 'EB Garamond', serif);
  font-size: 15px;
  line-height: 1.25;
  color: var(--kbn-graphite-soft);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  transition: color 120ms ease, background-color 120ms ease;
}
.set-railbtn:hover { background: color-mix(in srgb, var(--kbn-graphite) 5%, transparent); color: var(--kbn-graphite); }
.set-railbtn:focus-visible {
  outline: 1px dashed color-mix(in srgb, var(--kbn-owed) 70%, transparent);
  outline-offset: 1px;
}
.set-railbtn-active {
  background: color-mix(in srgb, var(--kbn-owed-bright) 16%, transparent);
  color: var(--kbn-graphite);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--kbn-owed-bright);
}

.set-railgroup { display: flex; flex-direction: column; gap: 2px; }
.set-railgroup + .set-railgroup { margin-top: 20px; }
.set-railgroup-label { padding: 5px 10px 8px; font-family: var(--font-mono); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--kbn-graphite-faint); }
.set-pane-heading { margin-bottom: 22px; }
.set-pane-heading h2 { font-size: 28px; font-weight: 500; line-height: 1.15; margin: 0 0 8px; }
.set-pane-heading p { margin: 0; color: var(--kbn-graphite-muted); font-size: 15px; line-height: 1.4; max-width: 36rem; }
.set-opening-options { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
.set-opening-options legend { padding: 0 0 10px; }
.set-opening-choice { display: flex; align-items: center; gap: 12px; border: 1px solid color-mix(in srgb, var(--kbn-graphite) 15%, transparent); border-radius: 4px; padding: 14px 16px; cursor: pointer; background: color-mix(in srgb, var(--kbn-blank) 22%, transparent); }
.set-opening-choice:hover { border-color: var(--kbn-graphite-faint); }
.set-opening-choice:focus-within { outline: 1px dashed var(--kbn-owed); outline-offset: 2px; }
.set-opening-selected { border-color: var(--kbn-owed-bright); background: color-mix(in srgb, var(--kbn-owed-bright) 8%, transparent); }
.set-opening-choice input { accent-color: var(--kbn-owed); width: 16px; height: 16px; margin: 0; flex-shrink: 0; }
.set-opening-choice strong { font-size: 18px; font-weight: 500; }
.set-opening-note { display: block; font-size: 14px; color: var(--kbn-graphite-muted); margin-top: 3px; }
.set-opening-default { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--kbn-owed-deep); }
.set-appearance-dark { margin-top: 26px; }
.set-appearance-swatch { width: 34px; height: 34px; border-radius: 3px; flex-shrink: 0; display: grid; place-items: center; font-size: 12px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kbn-blank) 8%, transparent); }
.set-opening-guidance { line-height: 1.5; font-size: 14px; color: var(--kbn-graphite-soft); margin: 14px 0 20px; }
.set-opening-tip { font-size: 15px; line-height: 1.45; border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 12%, transparent); padding: 16px 0 10px; }
.set-opening-tip strong { display: block; font-weight: 500; margin-bottom: 3px; }
.set-opening-details { margin-top: 22px; border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 12%, transparent); padding-top: 12px; color: var(--kbn-graphite-soft); font-size: 14px; line-height: 1.5; }
.set-opening-details summary { cursor: pointer; padding: 4px 0; }
.set-opening-details p { margin: 10px 0; }

/* ── The pane ──────────────────────────────────────────────────────────── */

.set-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 22px 22px;
}
.set-lede {
  margin: 0 0 14px;
  font-size: 14.5px;
  line-height: 1.45;
  color: var(--kbn-graphite-soft);
  max-width: 44rem;
}
.set-lede code, .set-mono {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 0.88em;
}
.set-section-label {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--kbn-owed);
  margin: 20px 0 7px;
}
.set-section-label:first-child { margin-top: 0; }

/* ── Rows: a path, a remote, an agent ──────────────────────────────────── */

.set-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
}
.set-row {
  display: flex;
  /* The row's own lines stack; the drop button sits on the first of them, not
     in the middle of a three-line remote. */
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
  min-width: 0;
}
.set-row-main {
  flex: 1 1 auto;
  min-width: 0;
  /* A column, not a run of inline spans: the name, how it is reached and
     whether it answered are three claims, and inline they read as one
     sentence with the spaces missing. */
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.set-row-path {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 12.5px;
  color: var(--kbn-graphite);
  word-break: break-all;
}
.set-row-note {
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--kbn-graphite-muted);
  word-break: break-word;
}
.set-row-note-owed { color: var(--kbn-owed-deep); }
.set-row-note-error { color: var(--kbn-error); word-break: break-word; }
.set-empty {
  padding: 10px 0;
  font-size: 14px;
  color: var(--kbn-graphite-faint);
  font-style: italic;
}

/* ── Controls ──────────────────────────────────────────────────────────── */

.set-input, .set-select, .set-textarea {
  font-family: var(--font-main, 'EB Garamond', serif);
  font-size: 15px;
  color: var(--kbn-graphite);
  background: var(--kbn-blank);
  border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
  border-radius: 3px;
  padding: 5px 8px;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
}
.set-input:focus, .set-select:focus, .set-textarea:focus {
  outline: none;
  border-color: var(--kbn-owed-bright);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--kbn-owed) 18%, transparent);
}
.set-textarea {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 12.5px;
  line-height: 1.5;
  resize: vertical;
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
  tab-size: 2;
}
.set-select { width: auto; min-width: 9rem; padding-right: 6px; }

.set-btn {
  appearance: none;
  font-family: var(--font-main, 'EB Garamond', serif);
  font-size: 13.5px;
  padding: 4px 12px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--kbn-graphite) 20%, transparent);
  background: transparent;
  color: var(--kbn-graphite-soft);
  cursor: pointer;
  flex: 0 0 auto;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}
.set-btn:hover:not(:disabled) { color: var(--kbn-graphite); border-color: color-mix(in srgb, var(--kbn-graphite) 38%, transparent); }
.set-btn:focus-visible { outline: 1px dashed color-mix(in srgb, var(--kbn-owed) 70%, transparent); outline-offset: 2px; }
.set-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.set-btn-primary {
  background: var(--kbn-owed-bright);
  color: var(--kbn-on-pigment);
  border-color: var(--kbn-owed-dark);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--kbn-rag) 25%, transparent) inset;
}
.set-btn-primary:hover:not(:disabled) { color: var(--kbn-on-pigment); border-color: color-mix(in srgb, var(--kbn-owed-bright) 48%, var(--kbn-ink)); }
/* Removal is quiet until you are on it: a row of red X's reads as a page full
   of errors, which is the opposite of what a settled configuration is. */
.set-btn-drop {
  padding: 2px 7px;
  font-size: 13px;
  color: var(--kbn-graphite-pale);
  border-color: transparent;
}
.set-btn-drop:hover:not(:disabled) { color: var(--kbn-error); border-color: color-mix(in srgb, var(--kbn-error) 35%, transparent); }

.set-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.set-actions-spacer { flex: 1 1 auto; }

.set-error {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--kbn-alarm) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--kbn-alarm) 50%, transparent);
  color: var(--kbn-error);
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.set-said {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--kbn-graphite) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--kbn-graphite) 12%, transparent);
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--kbn-graphite-soft);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 14rem;
  overflow: auto;
}

/* ── Fact tables: the host's own numbers ───────────────────────────────── */

.set-facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 14px;
  align-items: baseline;
  font-size: 13.5px;
  border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
  padding-top: 8px;
}
.set-facts dt {
  color: var(--kbn-graphite-muted);
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.set-facts dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 12.5px;
}

/* ── The file, underneath ──────────────────────────────────────────────── */

/* Every section ends with the file it is a form for. Folded shut, because the
   structured controls above are the ordinary path — but present, because they
   cannot express everything the file can, and a settings page that hides the
   fields it has no widget for is lying about being settings. */
.set-file {
  margin-top: 22px;
  border-top: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
  padding-top: 10px;
}
.set-file > summary {
  min-height: 32px;
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--kbn-graphite-faint);
}
.set-file > summary::-webkit-details-marker { display: none; }
.set-file > summary:hover { color: var(--kbn-graphite-muted); }
.set-file > summary:focus-visible { outline: 1px dashed color-mix(in srgb, var(--kbn-owed) 70%, transparent); outline-offset: 2px; }
.set-file > summary::before { content: '\\25B8'; font-size: 11px; }
.set-file[open] > summary::before { content: '\\25BE'; }
.set-file-path {
  margin: 8px 0 6px;
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 11.5px;
  color: var(--kbn-graphite-faint);
  word-break: break-all;
}
.set-file-absent { color: var(--kbn-owed-deep); }

/* ── Phone ─────────────────────────────────────────────────────────────── */

@media (max-width: 700px), (max-height: 500px) and (pointer: coarse) {
  /* The rail stops being a column and becomes a strip, for the same reason
     the board's own pages do: two columns inside 390px leaves neither one a
     readable measure. It scrolls sideways like the tab strip above it, and
     the section you are on scrolls itself into view on open. */
  .set-cols { flex-direction: column; }
  .set-rail {
    width: auto;
    flex-direction: row;
    gap: 4px;
    padding: 8px 12px;
    border-right: none;
    border-bottom: 1px solid color-mix(in srgb, var(--kbn-graphite) 10%, transparent);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .set-railgroup { flex-direction: row; flex: 0 0 auto; }
  .set-railgroup + .set-railgroup { margin: 0; padding-left: 8px; border-left: 1px solid color-mix(in srgb, var(--kbn-graphite) 15%, transparent); }
  .set-railgroup-label { display: none; }
  .set-pane-heading h2 { font-size: 25px; }
  .set-opening-choice { padding: 12px; }
  .set-rail::-webkit-scrollbar { display: none; }
  .set-railbtn {
    flex: 0 0 auto;
    box-shadow: none;
    border: 1px solid color-mix(in srgb, var(--kbn-graphite) 16%, transparent);
    padding: 6px 12px;
  }
  .set-railbtn-active { box-shadow: none; border-color: var(--kbn-owed-bright); }
  /* The host bar wraps rather than truncating. Which machine you are about to
     write to is the one fact on this page that must never be cut off mid-word,
     and 390px cannot hold the label, a host name and a sentence on one line. */
  .set-hostbar {
    padding: 8px 16px;
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .set-hostbar .set-select { flex: 1 1 8rem; min-width: 0; width: 0; }
  .set-done { order: 0; }
  .set-hostbar-note { order: 1; }
  .set-file > summary { min-height: 44px; }
  .set-hostbar-note {
    flex: 1 1 100%;
    white-space: normal;
    overflow: visible;
    font-size: 12.5px;
    line-height: 1.35;
  }
  .set-pane { padding: 14px 16px calc(20px + env(safe-area-inset-bottom, 0px)); }
  /* iOS zooms the page for any field under 16px and will not zoom back — and
     that applies to the textarea most of all, which is the main editing
     surface on the one device this sheet exists for. It gets a tighter line
     height instead of a smaller size: the thing to save on a phone is vertical
     space, not point size. */
  .set-input, .set-select, .set-textarea { font-size: 16px; }
  /* And 44px tall, which the font size alone does not give them. The select
     here is the HOST PICKER — the control that decides which machine
     everything else on this page writes to — and it was the smallest target on
     the sheet, at roughly 32px. (No backticks in this file: it is one big
     template literal, and one would end it.) */
  .set-input, .set-select { min-height: 44px; padding: 8px 10px; }
  .set-textarea { line-height: 1.35; }
  /* 44px, including — especially — the destructive one. The remove control had
     40 while the safe controls had 44, which is exactly backwards: a miss on
     Add costs a keystroke, a miss on ✕ costs a store. */
  .set-btn { min-height: 44px; padding: 8px 14px; }
  .set-btn-drop { min-height: 44px; min-width: 44px; }
  .set-railbtn { min-height: 44px; }
  .set-row { padding: 10px 0; }
  .set-facts { grid-template-columns: minmax(0, 1fr); gap: 1px 0; }
  .set-facts dt { margin-top: 8px; }
}
`
