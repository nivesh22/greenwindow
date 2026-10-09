// Europe/London display helpers for the follow-through actions (UTC everywhere else).
const TZ = 'Europe/London'
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** YYYY-MM-DD in London. */
export const londonDate = (iso: string): string => dateFmt.format(new Date(iso))
/** HH:mm in London. */
export const londonClock = (iso: string): string => clockFmt.format(new Date(iso))
