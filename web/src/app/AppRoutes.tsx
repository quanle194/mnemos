import { Route, Routes } from 'react-router'
import { AppLayout } from '@/components/layout/AppLayout'
import { AgentsPage } from '@/pages/AgentsPage'
import { ConflictDetailPage } from '@/pages/conflicts/ConflictDetailPage'
import { ConflictsPage } from '@/pages/conflicts/ConflictsPage'
import { DreamDetailPage } from '@/pages/dreams/DreamDetailPage'
import { DreamsPage } from '@/pages/dreams/DreamsPage'
import { EvalsPage } from '@/pages/EvalsPage'
import { EpisodeDetailPage } from '@/pages/experiences/EpisodeDetailPage'
import { ExperienceDetailPage } from '@/pages/experiences/ExperienceDetailPage'
import { ExperiencesPage } from '@/pages/experiences/ExperiencesPage'
import { GraphPage } from '@/pages/graph/GraphPage'
import { LoginPage } from '@/pages/LoginPage'
import { MemoriesPage } from '@/pages/memories/MemoriesPage'
import { MemoryDetailPage } from '@/pages/memories/MemoryDetailPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { TraceDetailPage } from '@/pages/settings/TraceDetailPage'
import { WorkspacesPage } from '@/pages/WorkspacesPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="memories" element={<MemoriesPage />} />
        <Route path="memories/:id" element={<MemoryDetailPage />} />
        <Route path="experiences" element={<ExperiencesPage />} />
        <Route path="experiences/:id" element={<ExperienceDetailPage />} />
        <Route path="episodes/:id" element={<EpisodeDetailPage />} />
        <Route path="dreams" element={<DreamsPage />} />
        <Route path="dreams/:id" element={<DreamDetailPage />} />
        <Route path="conflicts" element={<ConflictsPage />} />
        <Route path="conflicts/:id" element={<ConflictDetailPage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="evals" element={<EvalsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="traces/:id" element={<TraceDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
