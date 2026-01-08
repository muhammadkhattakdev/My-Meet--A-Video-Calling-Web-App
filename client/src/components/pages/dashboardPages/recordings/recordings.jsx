import { useState, useEffect } from "react";
import { Video, Calendar, Users, Trash2, Download } from "lucide-react";

import "./style.css";
import api from "../../../request";

const Recordings = () => {
  const [recordings, setRecordings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchRecordings();
  }, []);

  const fetchRecordings = async () => {
    try {
      const response = await api.get("/api/meetings/recordings");
      if (response.data.success) {
        setRecordings(response.data.data.recordings);
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to fetch recordings");
    } finally {
      setIsLoading(false);
    }
  };

  const deleteRecording = async (recordingId) => {
    if (!window.confirm("Are you sure you want to delete this recording?")) {
      return;
    }

    try {
      const response = await api.delete(
        `/api/meetings/recordings/${recordingId}`
      );
      if (response.data.success) {
        setRecordings(recordings.filter((r) => r._id !== recordingId));
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to delete recording");
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  if (isLoading) {
    return (
      <div className="recordings-loading">
        <div className="loading-spinner"></div>
        <p>Loading recordings...</p>
      </div>
    );
  }

  return (
    <div className="recordings-page">
      <div className="recordings-container">
        <div className="recordings-header">
          <div className="recordings-header-content">
            <Video size={32} />
            <div>
              <h1 className="recordings-title">My Recordings</h1>
              <p className="recordings-subtitle">
                View and manage your meeting recordings
              </p>
            </div>
          </div>
        </div>

        {error && <div className="recordings-error">{error}</div>}

        {recordings.length === 0 ? (
          <div className="recordings-empty">
            <Video size={64} strokeWidth={1} />
            <h3>No recordings yet</h3>
            <p>
              Your meeting recordings will appear here once you start recording
            </p>
          </div>
        ) : (
          <div className="recordings-grid">
            {recordings.map((recording) => (
              <div key={recording._id} className="recording-card">
                <div className="recording-thumbnail">
                  <Video size={48} />
                </div>

                <div className="recording-content">
                  <h3 className="recording-title">{recording.meetingTitle}</h3>

                  <div className="recording-meta">
                    <div className="recording-meta-item">
                      <Calendar size={14} />
                      <span>{formatDate(recording.recordedAt)}</span>
                    </div>

                    {recording.participants &&
                      recording.participants.length > 0 && (
                        <div className="recording-meta-item">
                          <Users size={14} />
                          <span>
                            {recording.participants.length} participants
                          </span>
                        </div>
                      )}
                  </div>

                  <div className="recording-details">
                    {recording.duration > 0 && (
                      <span className="recording-detail">
                        Duration: {formatDuration(recording.duration)}
                      </span>
                    )}
                    {recording.fileSize > 0 && (
                      <span className="recording-detail">
                        Size: {formatFileSize(recording.fileSize)}
                      </span>
                    )}
                  </div>

                  <div className="recording-actions">
                    <a
                      href={recording.recordingUrl}
                      download
                      className="btn-icon-secondary"
                      title="Download"
                    >
                      <Download size={18} />
                    </a>
                    <button
                      onClick={() => deleteRecording(recording._id)}
                      className="btn-icon-danger"
                      title="Delete"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Recordings;
