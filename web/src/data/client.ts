// Fetches the published JSON files with plain GETs: no custom headers, so no CORS preflight
// (the raw GitHub host does not answer preflights, spec V9). Every file is validated before use.
import { DataFetchError, DataSchemaError, parseFile } from './parse'
import { FILES, type FileData, type FileKey } from './schemas'

export { DataFetchError, DataSchemaError, SchemaVersionError, parseFile } from './parse'

const DEFAULT_BASE = 'https://raw.githubusercontent.com/nivesh22/greenwindow/data/app_data'

export const DATA_BASE_URL: string = (import.meta.env.VITE_DATA_BASE_URL as string | undefined) ?? DEFAULT_BASE

export async function fetchFile<K extends FileKey>(key: K, base?: string): Promise<FileData[K]> {
  const spec = FILES[key]
  const { file } = spec
  base ??= 'sameOrigin' in spec ? '' : DATA_BASE_URL
  let res: Response
  try {
    res = await fetch(`${base}/${file}`)
  } catch {
    throw new DataFetchError(file, `Network error loading ${file}`)
  }
  if (!res.ok) throw new DataFetchError(file, `${file}: HTTP ${res.status}`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new DataSchemaError(file, `${file} is not valid JSON`)
  }
  return parseFile(key, raw)
}
