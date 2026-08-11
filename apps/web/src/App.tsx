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
import { ImportPage } from './pages/ImportPage'
import { AuditCallDetailPage } from './pages/AuditCallDetailPage'
import { CallAuditReportPage } from './pages/CallAuditReportPage'
import { CallAuditSettingsPage } from './pages/CallAuditSettingsPage'

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
        <Route path="call-audit" element={<CallAuditReportPage />} />
        {/* Admin-only rule administration; the server gates it on config:manage. */}
        <Route
          path="call-audit/settings"
          element={<CallAuditSettingsPage />}
        />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="audits" element={<AuditMonitorPage />} />
        <Route
          path="audits/call"
          element={<AuditCallDetailPage />}
        />
        <Route path="imports/new" element={<ImportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
