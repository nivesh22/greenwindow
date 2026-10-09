// One Function for the scheduled jobs called by pg_cron (see api/_lib/dispatch.ts): /api/cron/{reminders,recurring,ledger}.
import { dispatcher } from './_lib/dispatch.js'
import ledger from './_routes/cron_ledger.js'
import recurring from './_routes/cron_recurring.js'
import reminders from './_routes/cron_reminders.js'

export const maxDuration = 60

export default dispatcher('cron', { reminders, recurring, ledger })
