import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { BillingPage } from './pages/BillingPage'
import { EvidencePage } from './pages/EvidencePage'
import { FindingsPage } from './pages/FindingsPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { OperationsPage } from './pages/OperationsPage'
import { OverviewPage } from './pages/OverviewPage'
import { ReportsPage } from './pages/ReportsPage'
import { AuditMonitorPage } from './pages/AuditMonitorPage'

export function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="evidence" element={<EvidencePage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="audits" element={<AuditMonitorPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
