import type { ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

/** Tiny safe formatter: paragraphs, "- " bullet lists, **bold**. Everything is rendered as React text nodes. */
export function FormattedText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let para: string[] = []
  let items: string[] = []
  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length}>{para.flatMap((l, i) => (i ? [<br key={`b${i}`} />, ...inline(l)] : inline(l)))}</p>)
    }
    para = []
  }
  const flushList = () => {
    if (items.length) {
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">
          {items.map((l, i) => <li key={i}>{inline(l)}</li>)}
        </ul>,
      )
    }
    items = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      flushPara()
      flushList()
    } else if (line.startsWith('- ')) {
      flushPara()
      items.push(line.slice(2))
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return <div className="space-y-2">{blocks}</div>
}

