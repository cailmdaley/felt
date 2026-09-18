import { createContext, useContext, useEffect } from 'react'

/** Drafts may be discarded; in-flight writes must finish before navigation. */
export const SettingsDraftContext = createContext<(id: string, dirty: boolean, busy: boolean) => void>(() => {})

export function useSettingsDraft(id: string, dirty: boolean, busy: boolean): void {
  const notify = useContext(SettingsDraftContext)
  useEffect(() => { notify(id, dirty, busy) }, [notify, id, dirty, busy])
  useEffect(() => () => { notify(id, false, false) }, [notify, id])
}
