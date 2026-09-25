/**
 * AppDialog — the paper card shared by the React forms, built on Radix Dialog.
 *
 * Gives focus trap, escape-to-close, accessible labelling, scroll lock, and
 * portal-to-body for free. The standalone UI has no competing modal stack, so
 * the z-index just needs to clear the board (10000/10001 for headroom).
 *
 * The chrome shares the forms' manuscript language: a warm paper field
 * (#F4F0E8) under a slightly darker header band, a brass hairline under the
 * header, and EB Garamond throughout. Stash builds its card from an injected
 * sheet because its card has a dozen internal parts; this reusable dialog
 * carries its chrome inline, with one small sheet for the entrance keyframes
 * (CSS-only, so Radix's mount is what triggers it).
 */

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

/** Entrance keyframes — the one thing inline styles cannot express. Idempotent
 *  by element id, the same pattern as `injectStashFormStyles`. */
function injectAppDialogStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('app-dialog-styles')) return
  const style = document.createElement('style')
  style.id = 'app-dialog-styles'
  style.textContent = `
    @keyframes app-dialog-scrim-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes app-dialog-card-in {
      from { transform: translate(-50%, calc(-50% - 6px)); opacity: 0; }
      to   { transform: translate(-50%, -50%); opacity: 1; }
    }
    /* GEOMETRY LIVES HERE, not in the inline style object beside it, for one
       reason: an inline style cannot be answered by a media query, and below
       700px this card stops being a centred sheet of paper and becomes the
       whole screen. The paper — ground, border, shadow, type — stays inline;
       only the shape a viewport can argue with is written as a rule. */
    .app-dialog-card {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      /* 46rem holds four controls at a comfortable width without the yap's
         measure running past a readable line. */
      width: min(46rem, 92vw);
      max-height: 85vh;
      border-radius: 4px;
      animation: app-dialog-card-in 160ms ease-out;
    }
    /* A card carrying its own two-column page rather than one stack of fields
       — the settings sheet. Wider because a rail plus a pane needs the room,
       and taller because the thing being edited is a file, not a form: the
       measure that matters is how much of it you can see at once. */
    .app-dialog-card-wide {
      width: min(64rem, 94vw);
      max-height: 88vh;
      height: min(44rem, 88vh);
    }
    @media (max-width: 700px), (max-height: 500px) and (pointer: coarse) {
      .app-dialog-card {
        top: 0;
        left: 0;
        transform: none;
        width: 100%;
        /* dvh, not vh: the mobile browser's collapsing chrome makes vh taller
           than the screen, which puts the submit button under the fold at the
           exact moment the keyboard is up. */
        height: 100dvh;
        max-height: 100dvh;
        border: none;
        border-radius: 0;
        box-shadow: none;
        animation: app-dialog-sheet-in 160ms ease-out;
      }
      /* Every field at 16px, because iOS zooms the page for anything smaller
         and a zoomed page cannot be scrolled back. */
      .app-dialog-card input,
      .app-dialog-card select,
      .app-dialog-card textarea {
        font-size: 16px;
      }
      .app-dialog-card button {
        min-height: 44px;
      }
      /* The footer belongs to the BOTTOM EDGE, two ways, because a form can
         be shorter or taller than the screen and both must land right.
         min-height plus margin-top:auto pushes it down when the content is
         short (otherwise it floats mid-screen with a field of blank paper
         under it); sticky pins it when the content scrolls, which is the
         case that matters once the keyboard is up. */
      .app-dialog-body > .capture-form,
      .app-dialog-body > .meeting-form {
        min-height: 100%;
      }
      .app-dialog-body > * > .capture-foot,
      .app-dialog-body > * > .meeting-foot {
        margin-top: auto;
        position: sticky;
        bottom: -16px;
        margin-left: -22px;
        margin-right: -22px;
        margin-bottom: -16px;
        padding: 10px 22px calc(14px + env(safe-area-inset-bottom, 0px));
        background: #EFEAE0;
        border-top: 1px solid rgba(46, 42, 38, 0.10);
      }
      /* Esc and ⌘↵ are a keyboard's line, and a phone has neither key. */
      .app-dialog-body > * > .capture-foot > .capture-foot-hint,
      .app-dialog-body > * > .meeting-foot > .meeting-foot-hint {
        display: none;
      }
      .app-dialog-body > * > .capture-foot > .capture-buttons,
      .app-dialog-body > * > .meeting-foot > .meeting-buttons {
        flex: 1;
        gap: 10px;
      }
      .app-dialog-body > * > .capture-foot > .capture-buttons > .capture-btn,
      .app-dialog-body > * > .meeting-foot > .meeting-buttons > .meeting-btn {
        flex: 1;
      }
    }
    @keyframes app-dialog-sheet-in {
      from { transform: translateY(10px); opacity: 0; }
      to   { transform: none; opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .app-dialog-card { animation: none; }
    }
  `
  document.head.appendChild(style)
}

const appDialogOverlayStyles: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(46, 42, 38, 0.45)',
  backdropFilter: 'blur(2px)',
  zIndex: 10000,
  animation: 'app-dialog-scrim-in 120ms ease-out',
}

/** The paper, and only the paper — see `.app-dialog-card` for the shape. */
const appDialogContentStyles: React.CSSProperties = {
  background: '#F4F0E8',
  backgroundImage:
    'linear-gradient(135deg, rgba(154, 123, 53, 0.025) 0%, transparent 60%),' +
    'linear-gradient(315deg, rgba(46, 42, 38, 0.020) 0%, transparent 70%)',
  color: '#2E2A26',
  fontFamily: "var(--font-main, 'EB Garamond', serif)",
  border: '1px solid rgba(46, 42, 38, 0.22)',
  boxShadow:
    '0 1px 0 rgba(255, 252, 245, 0.6) inset,' +
    '0 14px 36px rgba(46, 42, 38, 0.26),' +
    '0 2px 6px rgba(46, 42, 38, 0.12)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  zIndex: 10001,
}

const headerStyles: React.CSSProperties = {
  position: 'relative',
  padding: '13px 22px 11px',
  background: '#E5DED2',
  borderBottom: '1px solid rgba(46, 42, 38, 0.10)',
  flex: 'none',
}

/** The brass hairline that fades out at both ends — Stash's `.stash-header-rule`. */
const headerRuleStyles: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: '-1px',
  height: '1px',
  background:
    'linear-gradient(to right, transparent 0%, rgba(154, 123, 53, 0) 6%,' +
    ' rgba(154, 123, 53, 0.55) 50%, rgba(154, 123, 53, 0) 94%, transparent 100%)',
}

export interface AppDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: ReactNode
  /** Small mono kicker on the right of the title row (e.g. `shuttle · capture`). */
  eyebrow?: ReactNode
  /**
   * Widen and fix the card's height — for a child that is a PAGE (a rail and
   * a pane) rather than a column of fields. A form should be as tall as its
   * fields; a page should be as tall as the room allows, so its own scroll
   * region does not change size as you move between sections.
   */
  wide?: boolean
  /**
   * Hand the body to the child whole: no padding, no scroll of its own.
   *
   * The default body is one padded scroll region, which is right for a form
   * and wrong for anything with two panes — a single outer scrollbar would
   * carry the rail off the top of the card as you read down the pane. A flush
   * child owns its own layout and its own overflow.
   */
  flush?: boolean
  children: ReactNode
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  eyebrow,
  wide,
  flush,
  children,
}: AppDialogProps): JSX.Element {
  injectAppDialogStyles()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={appDialogOverlayStyles} />
        <Dialog.Content
          className={wide ? 'app-dialog-card app-dialog-card-wide' : 'app-dialog-card'}
          style={appDialogContentStyles}
          // Radix warns unless a Description is rendered or the attribute is
          // explicitly opted out of. A dialog whose own fields say what it does
          // needs no gloss, so drop the attribute rather than invent one.
          aria-describedby={undefined}
        >
          <div style={headerStyles}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <Dialog.Title
                style={{
                  margin: 0,
                  fontSize: '19px',
                  fontWeight: 600,
                  letterSpacing: '0.01em',
                  lineHeight: 1.2,
                }}
              >
                {title}
              </Dialog.Title>
              {eyebrow && (
                <span
                  style={{
                    fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
                    fontSize: '10px',
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: '#9A8E80',
                  }}
                >
                  {eyebrow}
                </span>
              )}
            </div>
            <span style={headerRuleStyles} aria-hidden="true" />
          </div>
          {/* One scroll region; the child owns its own internal rhythm so the
              form's blocks are all direct siblings on one alignment grid. */}
          <div
            className="app-dialog-body"
            style={
              flush
                ? { flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' }
                : { padding: '15px 22px 16px', overflowY: 'auto', flex: '1 1 auto' }
            }
          >
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
