import { Link, useNavigate } from "react-router-dom";
import { LogOut, Sun, Moon, User } from "lucide-react";
import { useApp } from "../../../context/context";
import logo from "../../../static/logo2.png";
import "./style.css";

const Navbar = () => {
  const { user, logout, theme, toggleTheme } = useApp();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/signin");
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/" className="navbar-logo">
          <img src={logo} alt="MyMeet" className="navbar-logo-img" />
        </Link>

        <div className="navbar-actions">
          <button
            onClick={toggleTheme}
            className="navbar-icon-btn"
            aria-label="Toggle theme"
          >
            {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
          </button>

          <Link to="/recordings" className="navbar-link">
            Recordings
          </Link>

          <div className="navbar-user">
            <User size={18} />
            <span>{user?.fullName}</span>
          </div>

          <button
            onClick={handleLogout}
            className="navbar-icon-btn navbar-logout"
            aria-label="Logout"
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
