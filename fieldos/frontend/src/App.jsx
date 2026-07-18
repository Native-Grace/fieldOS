import { Navigate, Route, Routes } from "react-router-dom";
import { getToken } from "./api";
import LoginPage from "./pages/LoginPage";
import JobsPage from "./pages/JobsPage";
import JobDetailPage from "./pages/JobDetailPage";
import RecorderPage from "./pages/RecorderPage";

function Private({ children }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Private>
              <JobsPage />
            </Private>
          }
        />
        <Route
          path="/jobs/:jobSheetId"
          element={
            <Private>
              <JobDetailPage />
            </Private>
          }
        />
        <Route
          path="/jobs/:jobSheetId/record"
          element={
            <Private>
              <RecorderPage />
            </Private>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
