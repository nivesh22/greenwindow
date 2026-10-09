// One Function for the signed-in P4 endpoints (see api/_lib/dispatch.ts): /api/plans, /api/push/subscribe, /api/reminders.
import { dispatcher } from './_lib/dispatch.js'
import plans from './_routes/plans.js'
import pushSubscribe from './_routes/push_subscribe.js'
import reminders from './_routes/reminders.js'

export const maxDuration = 15

export default dispatcher('user', { plans, 'push-subscribe': pushSubscribe, reminders })
