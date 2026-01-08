import { Navigate } from "react-router-dom";
import { useApp } from "../context/context";

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading } = useApp();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          backgroundColor: "var(--bg-app)",
        }}
      >
        <div
          style={{
            fontSize: "var(--font-size-lg)",
            color: "var(--text-secondary)",
          }}
        >
          Loading...
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/signin" replace />;
  }

  return children;
};

export default ProtectedRoute;
