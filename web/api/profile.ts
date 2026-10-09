// GET/PUT /api/profile: profile and saved devices. Signed-in (non-anonymous) users only.
import { profileUpdateSchema, type ProfileResponse } from '../agent/harness/api_schemas.js'
import type { Profile } from '../agent/store/user_types.js'
import { authenticate, lazyFetch, methodNotAllowed, readBody, unauthorized, type ApiDeps } from './_lib/deps.js'
import { errorBody, json } from './_lib/http.js'

export const maxDuration = 15

async function load(deps: ApiDeps, userId: string): Promise<ProfileResponse> {
  const [p, devices] = await Promise.all([deps.users.getProfile(userId), deps.users.listDevices(userId)])
  return {
    profile: { display_name: p?.displayName ?? null, risk_default: p?.riskDefault ?? 'expected', quiet_from: p?.quietFrom ?? null, quiet_to: p?.quietTo ?? null },
    devices: devices.map((d) => ({ id: d.id, name: d.name, kw: d.kw, typical_hours: d.typicalHours })),
  }
}

export function createProfileHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'PUT') return methodNotAllowed('GET, PUT')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    if (auth.isAnonymous) return json(403, errorBody('sign_in_required', 'Sign in to use a profile.'))
    try {
      if (request.method === 'GET') return json(200, await load(deps, auth.userId))
      const body = await readBody(request, profileUpdateSchema)
      if (body instanceof Response) return body
      if (body.profile) {
        const p: Profile = {
          userId: auth.userId,
          displayName: body.profile.display_name,
          riskDefault: body.profile.risk_default,
          quietFrom: body.profile.quiet_from,
          quietTo: body.profile.quiet_to,
        }
        await deps.users.upsertProfile(p)
      }
      if (body.delete_device_ids) for (const id of body.delete_device_ids) await deps.users.deleteDevice(auth.userId, id)
      if (body.upsert_devices) {
        const existing = await deps.users.listDevices(auth.userId)
        for (const d of body.upsert_devices) {
          const prior = existing.find((e) => e.id === d.id) ?? existing.find((e) => e.name === d.name)
          await deps.users.saveDevice({ id: d.id, userId: auth.userId, name: d.name, kw: d.kw, typicalHours: d.typical_hours, sourceDeviceId: prior?.sourceDeviceId ?? null })
        }
      }
      return json(200, await load(deps, auth.userId))
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not reach your profile right now.'))
    }
  }
}

export default lazyFetch(createProfileHandler)
