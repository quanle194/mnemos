/** aria-describedby value matching the ids rendered by <Field>. */
export function describedBy(id: string, error?: string, hint?: boolean): string | undefined {
  if (error) return `${id}-error`
  return hint ? `${id}-hint` : undefined
}
