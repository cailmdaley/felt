/**
 * The settings sheet's chrome, as one idempotent stylesheet.
 *
 * It speaks the forms' manuscript palette (paper `#F4F0E8`, band `#E5DED2`,
 * brass `#C49333`, iron-gall hairlines) rather than the board's pigment
 * variables, because it lives inside `AppDialog` alongside Stash and Capture
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
 * Injected by element id on first render, the same pattern as
 * `injectStashFormStyles` and `injectCaptureFormStyles`.
 */

let injected = false

export function injectSettingsStyles(): void {
  if (typeof document === 'undefined') return
  if (injected || document.getElementById('shuttle-settings-styles')) {
    injected = true
    return
  }
  injected = true
  const style = document.createElement('style')
  style.id = 'shuttle-settings-styles'
  style.textContent = SHEET
  document.head.appendChild(style)
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
  color: #2E2A26;
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
  background: #EFEAE0;
  border-bottom: 1px solid rgba(46, 42, 38, 0.10);
}
.set-hostbar-label {
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #9A8E80;
  flex: 0 0 auto;
}
.set-hostbar-note {
  font-size: 13px;
  color: #7A7068;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.set-hostbar-stale {
  color: #8A6A20;
}

.set-cols {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* ── The rail ──────────────────────────────────────────────────────────── */

.set-rail {
  flex: 0 0 auto;
  width: 9.5rem;
  padding: 12px 0 12px 12px;
  border-right: 1px solid rgba(46, 42, 38, 0.10);
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
  color: #5C544D;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  transition: color 120ms ease, background-color 120ms ease;
}
.set-railbtn:hover { background: rgba(46, 42, 38, 0.05); color: #2E2A26; }
.set-railbtn:focus-visible {
  outline: 1px dashed rgba(154, 123, 53, 0.7);
  outline-offset: 1px;
}
.set-railbtn-active {
  background: rgba(196, 147, 51, 0.16);
  color: #2E2A26;
  font-weight: 600;
  box-shadow: inset 2px 0 0 #C49333;
}

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
  color: #5C544D;
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
  color: #9A7B35;
  margin: 20px 0 7px;
}
.set-section-label:first-child { margin-top: 0; }

/* ── Rows: a path, a remote, an agent ──────────────────────────────────── */

.set-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid rgba(46, 42, 38, 0.10);
}
.set-row {
  display: flex;
  /* The row's own lines stack; the drop button sits on the first of them, not
     in the middle of a three-line remote. */
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(46, 42, 38, 0.10);
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
  color: #2E2A26;
  word-break: break-all;
}
.set-row-note {
  font-size: 12.5px;
  line-height: 1.4;
  color: #7A7068;
  word-break: break-word;
}
.set-row-note-owed { color: #8A6A20; }
.set-row-note-error { color: #8B3A28; word-break: break-word; }
.set-empty {
  padding: 10px 0;
  font-size: 14px;
  color: #9A8E80;
  font-style: italic;
}

/* ── Controls ──────────────────────────────────────────────────────────── */

.set-input, .set-select, .set-textarea {
  font-family: var(--font-main, 'EB Garamond', serif);
  font-size: 15px;
  color: #2E2A26;
  background: #FFFFFF;
  border: 1px solid rgba(46, 42, 38, 0.20);
  border-radius: 3px;
  padding: 5px 8px;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
}
.set-input:focus, .set-select:focus, .set-textarea:focus {
  outline: none;
  border-color: #C49333;
  box-shadow: 0 0 0 2px rgba(154, 123, 53, 0.18);
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
  border: 1px solid rgba(46, 42, 38, 0.20);
  background: transparent;
  color: #5C544D;
  cursor: pointer;
  flex: 0 0 auto;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}
.set-btn:hover:not(:disabled) { color: #2E2A26; border-color: rgba(46, 42, 38, 0.38); }
.set-btn:focus-visible { outline: 1px dashed rgba(154, 123, 53, 0.7); outline-offset: 2px; }
.set-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.set-btn-primary {
  background: #C49333;
  color: #FFFFFF;
  border-color: #7A6028;
  box-shadow: 0 1px 0 rgba(255, 252, 245, 0.25) inset;
}
.set-btn-primary:hover:not(:disabled) { color: #FFFFFF; border-color: #6A521F; }
/* Removal is quiet until you are on it: a row of red X's reads as a page full
   of errors, which is the opposite of what a settled configuration is. */
.set-btn-drop {
  padding: 2px 7px;
  font-size: 13px;
  color: #B5A998;
  border-color: transparent;
}
.set-btn-drop:hover:not(:disabled) { color: #8B3A28; border-color: rgba(139, 58, 40, 0.35); }

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
  background: rgba(178, 78, 60, 0.12);
  border: 1px solid rgba(178, 78, 60, 0.5);
  color: #8B3A28;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.set-said {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 3px;
  background: rgba(46, 42, 38, 0.05);
  border: 1px solid rgba(46, 42, 38, 0.12);
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 12px;
  line-height: 1.5;
  color: #5C544D;
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
  border-top: 1px solid rgba(46, 42, 38, 0.10);
  padding-top: 8px;
}
.set-facts dt {
  color: #7A7068;
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
  border-top: 1px solid rgba(46, 42, 38, 0.10);
  padding-top: 10px;
}
.set-file > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #9A8E80;
}
.set-file > summary::-webkit-details-marker { display: none; }
.set-file > summary:hover { color: #7A7068; }
.set-file > summary:focus-visible { outline: 1px dashed rgba(154, 123, 53, 0.7); outline-offset: 2px; }
.set-file > summary::before { content: '\\25B8'; font-size: 11px; }
.set-file[open] > summary::before { content: '\\25BE'; }
.set-file-path {
  margin: 8px 0 6px;
  font-family: var(--font-mono, 'IBM Plex Mono', monospace);
  font-size: 11.5px;
  color: #9A8E80;
  word-break: break-all;
}
.set-file-absent { color: #8A6A20; }

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
    border-bottom: 1px solid rgba(46, 42, 38, 0.10);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .set-rail::-webkit-scrollbar { display: none; }
  .set-railbtn {
    flex: 0 0 auto;
    box-shadow: none;
    border: 1px solid rgba(46, 42, 38, 0.16);
    padding: 6px 12px;
  }
  .set-railbtn-active { box-shadow: none; border-color: #C49333; }
  /* The host bar wraps rather than truncating. Which machine you are about to
     write to is the one fact on this page that must never be cut off mid-word,
     and 390px cannot hold the label, a host name and a sentence on one line. */
  .set-hostbar {
    padding: 8px 16px;
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .set-hostbar .set-select { flex: 1 1 auto; min-width: 0; }
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
