import { londonDate } from './london'

export const actionBtn =
  'inline-block rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800'

/** Download text as a file from the browser (no server round trip). */
export function downloadText(filename: string, text: string, type = 'text/calendar;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** "Download .ics" + "Add to Google Calendar" for one planned window. */
export function CalendarButtons({ ics, googleUrl, startUtc }: { ics: string; googleUrl: string; startUtc: string }) {
  return (
    <>
      <button type="button" className={actionBtn} onClick={() => downloadText(`greenwindow-${londonDate(startUtc)}.ics`, ics)}>
        Download .ics
      </button>
      <a className={actionBtn} href={googleUrl} target="_blank" rel="noopener noreferrer">
        Add to Google Calendar
      </a>
    </>
  )
}
