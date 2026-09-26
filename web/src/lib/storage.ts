/** localStorage access that never throws (private mode, blocked storage, SSR/tests). */
export const storage = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value)
    } catch {
      // storage unavailable: state stays in memory for this tab
    }
  },
  remove(key: string): void {
    try {
      globalThis.localStorage?.removeItem(key)
    } catch {
      // ignore
    }
  },
}
