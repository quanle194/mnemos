import { Button } from '@/components/ui/button'

export interface PagedQuery {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => unknown
}

interface Props {
  query: PagedQuery
  'data-testid'?: string
}

export function LoadMore({ query, ...rest }: Props) {
  if (!query.hasNextPage) return null
  return (
    <div className="flex justify-center pt-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void query.fetchNextPage()}
        disabled={query.isFetchingNextPage}
        data-testid={rest['data-testid'] ?? 'load-more'}
      >
        {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  )
}
