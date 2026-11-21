import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import UserHome from "./pages/UserHome";
import AdminLayout from "./pages/admin/AdminLayout";
import Dashboard from "./pages/admin/Dashboard";
import Users from "./pages/admin/Users";
import UserDetail from "./pages/admin/UserDetail";
import SettingsPage from "./pages/admin/Settings";
import Alerts from "./pages/admin/Alerts";
import Departments from "./pages/admin/Departments";
import { isManager, type Role } from "./types";

function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) {
    return <Navigate to={isManager(user.role) ? "/admin" : "/"} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireRole roles={["user"]}>
            <UserHome />
          </RequireRole>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireRole roles={["admin", "team_lead"]}>
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="users" element={<Users />} />
        <Route path="users/:id" element={<UserDetail />} />
        <Route path="alerts" element={<Alerts />} />
        <Route
          path="departments"
          element={
            <RequireRole roles={["admin"]}>
              <Departments />
            </RequireRole>
          }
        />
        <Route
          path="settings"
          element={
            <RequireRole roles={["admin"]}>
              <SettingsPage />
            </RequireRole>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
