import { useInfiniteQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import type { Page } from '../types'

export const PAGE_SIZE = 25

/** Keyset pagination over `{items, next_cursor}` endpoints ("Load more"). */
export function useCursorList<T>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  const query = useInfiniteQuery<
    Page<T>,
    Error,
    InfiniteData<Page<T>, string | undefined>,
    QueryKey,
    string | undefined
  >({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  })
  const items: T[] = query.data?.pages.flatMap((p) => p.items) ?? []
  return { ...query, items }
}
