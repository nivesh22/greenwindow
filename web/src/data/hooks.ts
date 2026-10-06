import { QueryClient, useQuery } from '@tanstack/react-query'
import { DataFetchError, fetchFile } from './client'
import type { FileKey } from './schemas'

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15 * 60 * 1000,
        refetchOnWindowFocus: true,
        // one retry for network errors only; a bad file will not fix itself
        retry: (count, err) => count < 1 && !(err instanceof DataFetchError && err.constructor !== DataFetchError),
        retryDelay: 2000,
      },
    },
  })
}

export function useDataFile<K extends FileKey>(key: K) {
  return useQuery({ queryKey: ['data', key], queryFn: () => fetchFile(key) })
}
