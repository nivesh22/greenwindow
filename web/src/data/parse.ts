// Pure parsing of the published JSON files (no fetch, no import.meta.env), shared by the app and the agent server.
import { FILES, SUPPORTED_SCHEMA_VERSION, type FileData, type FileKey } from './schemas.js'

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
