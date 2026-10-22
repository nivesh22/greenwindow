/** Up to two initials from the name, else the first letter of the email. */
export function initials(name: string | null, email: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length) return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase()
  return (email?.trim()[0] ?? '?').toUpperCase()
}
