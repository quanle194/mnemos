import { Link } from 'react-router'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Button asChild variant="outline" size="sm" className="mt-2">
        <Link to="/">Back to overview</Link>
      </Button>
    </EmptyState>
  )
}
