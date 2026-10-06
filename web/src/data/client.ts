// Fetches the published JSON files with plain GETs: no custom headers, so no CORS preflight
// (the raw GitHub host does not answer preflights, spec V9). Every file is validated before use.
import { FILES, SUPPORTED_SCHEMA_VERSION, type FileData, type FileKey } from './schemas'

const DEFAULT_BASE = 'https://raw.githubusercontent.com/nivesh22/greenwindow/data/app_data'

export const DATA_BASE_URL: string = (import.meta.env.VITE_DATA_BASE_URL as string | undefined) ?? DEFAULT_BASE

export class DataFetchError extends Error {
  readonly file: string
  constructor(file: string, message: string) {
    super(message)
    this.file = file
  }
}
export class DataSchemaError extends DataFetchError {}
export class SchemaVersionError extends DataFetchError {}

export function parseFile<K extends FileKey>(key: K, raw: unknown): FileData[K] {
  const { file, schema } = FILES[key]
  const version = typeof raw === 'object' && raw !== null ? (raw as { schema_version?: unknown }).schema_version : undefined
  if (typeof version === 'number' && Math.floor(version) !== SUPPORTED_SCHEMA_VERSION) {
    throw new SchemaVersionError(file, `${file} has schema_version ${version}; this page supports ${SUPPORTED_SCHEMA_VERSION}`)
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new DataSchemaError(file, `${file} failed validation: ${result.error.issues[0]?.message ?? 'unknown'}`)
  }
  return result.data as FileData[K]
}

export async function fetchFile<K extends FileKey>(key: K, base: string = DATA_BASE_URL): Promise<FileData[K]> {
  const { file } = FILES[key]
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
