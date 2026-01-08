import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useApp } from '../context/context';
import ProtectedRoute from './protectedRoute';

// Auth pages
import Signin from './pages/signin/signin';
import Signup from './pages/signup/signup';

// Dashboard pages
import DashboardLayout from './dashboardComponents/dashboardLayout/dashboardLayout';
import Homepage from './pages/dashboardPages/homepage/homepage';
import MeetingRoom from './pages/dashboardPages/meetingRoom/meetingRoom';
import Recordings from './pages/dashboardPages/recordings/recordings';

const Router = () => {
  const { isAuthenticated } = useApp();

  return (
    <BrowserRouter>
      <Routes>
        {/* Redirect root based on auth status */}
        <Route
          path="/"
          element={
            isAuthenticated ? (
              <Navigate to="/create-room" replace />
            ) : (
              <Navigate to="/signin" replace />
            )
          }
        />

        {/* Auth routes */}
        <Route
          path="/signin"
          element={
            isAuthenticated ? (
              <Navigate to="/create-room" replace />
            ) : (
              <Signin />
            )
          }
        />
        <Route
          path="/signup"
          element={
            isAuthenticated ? (
              <Navigate to="/create-room" replace />
            ) : (
              <Signup />
            )
          }
        />

        {/* Protected dashboard routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route path="create-room" element={<Homepage />} />
          <Route path="recordings" element={<Recordings />} />
        </Route>

        {/* Meeting room - protected but outside layout */}
        <Route
          path="/room/:meetingId"
          element={
            <ProtectedRoute>
              <MeetingRoom />
            </ProtectedRoute>
          }
        />

        {/* 404 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default Router;