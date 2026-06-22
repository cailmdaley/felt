/**
 * AppDialog — a thin Radix Dialog wrapper for the Stash/Capture islands.
 *
 * Gives focus trap, escape-to-close, accessible labelling, scroll lock, and
 * portal-to-body for free. Ported from Portolan's `src/ui/AppDialog.tsx`;
 * the standalone UI has no competing modal stack, so the z-index just needs
 * to clear the board (kept at the original 10000/10001 for headroom).
 */

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

export const appDialogOverlayStyles: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(20, 16, 12, 0.42)',
  backdropFilter: 'blur(2px)',
  zIndex: 10000,
}

export const appDialogContentStyles: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'var(--surface, #FBF8F3)',
  color: 'var(--text, #2A2118)',
  border: '1px solid var(--border-muted, #D8D2C8)',
  borderRadius: '6px',
  padding: '1.25rem 1.4rem',
  minWidth: '20rem',
  maxWidth: 'min(40rem, 92vw)',
  maxHeight: '85vh',
  overflow: 'auto',
  zIndex: 10001,
  boxShadow: '0 12px 28px rgba(20, 16, 12, 0.18)',
}

export interface AppDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Visually hide the title but keep it readable to screen readers. Default false. */
  titleVisuallyHidden?: boolean
  children: ReactNode
}

export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  titleVisuallyHidden = false,
  children,
}: AppDialogProps): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={appDialogOverlayStyles} />
        <Dialog.Content style={appDialogContentStyles}>
          <Dialog.Title
            style={
              titleVisuallyHidden
                ? {
                    position: 'absolute',
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: 'hidden',
                    clip: 'rect(0, 0, 0, 0)',
                    whiteSpace: 'nowrap',
                    border: 0,
                  }
                : {
                    margin: 0,
                    fontSize: '1rem',
                    fontWeight: 500,
                    paddingBottom: '0.4rem',
                    borderBottom: '1px solid var(--border-muted, #E5DFD5)',
                  }
            }
          >
            {title}
          </Dialog.Title>
          {description && (
            <Dialog.Description
              style={{
                margin: '0.4rem 0 0.85rem',
                fontSize: '0.85rem',
                opacity: 0.7,
                lineHeight: 1.5,
              }}
            >
              {description}
            </Dialog.Description>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
