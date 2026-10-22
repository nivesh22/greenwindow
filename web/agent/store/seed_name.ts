// Fills an empty display_name from the Google name on the verified token, so a new account starts with the user's
// name. A name already set (in Settings or by the assistant) is never overwritten.
import type { AuthUser, Profile, UserStore } from './user_types.js'

export async function seedDisplayName(users: Pick<UserStore, 'upsertProfile'>, auth: AuthUser, profile: Profile | null): Promise<Profile | null> {
  if (auth.isAnonymous || !auth.name || profile?.displayName) return profile
  try {
    return await users.upsertProfile({
      userId: auth.userId,
      displayName: auth.name,
      riskDefault: profile?.riskDefault ?? 'expected',
      quietFrom: profile?.quietFrom ?? null,
      quietTo: profile?.quietTo ?? null,
    })
  } catch (err) {
    console.error('seedDisplayName failed', err instanceof Error ? err.message : 'unknown')
    return profile
  }
}
