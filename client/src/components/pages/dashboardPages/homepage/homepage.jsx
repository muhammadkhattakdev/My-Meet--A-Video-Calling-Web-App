import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, Plus, LogIn } from 'lucide-react';
import './style.css';
import api from '../../../request';
import { useApp } from '../../../../context/context';

const Homepage = () => {
  const navigate = useNavigate();
  const { user } = useApp();
  const [meetingId, setMeetingId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreateMeeting = async () => {
    setIsCreating(true);
    setError('');

    try {
      const response = await api.post('/api/meetings/create', {
        title: `${user.fullName}'s Meeting`,
      });

      if (response.data.success) {
        const meetingId = response.data.data.meeting.meetingId;
        navigate(`/room/${meetingId}`);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create meeting');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinMeeting = () => {
    if (!meetingId.trim()) {
      setError('Please enter a meeting ID');
      return;
    }
    navigate(`/room/${meetingId.trim()}`);
  };

  return (
    <div className="homepage">
      <div className="homepage-container">
        <div className="homepage-hero">
          <div className="homepage-hero-icon">
            <Video size={64} strokeWidth={1.5} />
          </div>
          <h1 className="homepage-title">
            Welcome to MyMeet
          </h1>
          <p className="homepage-subtitle">
            Create or join a meeting to get started
          </p>
        </div>

        <div className="homepage-actions">
          <div className="homepage-card">
            <div className="card-icon create">
              <Plus size={28} />
            </div>
            <h3 className="card-title">Create Meeting</h3>
            <p className="card-description">
              Start a new video meeting and invite others to join
            </p>
            <button
              onClick={handleCreateMeeting}
              className="btn btn-primary w-full"
              disabled={isCreating}
            >
              {isCreating ? 'Creating...' : 'Create Meeting'}
            </button>
          </div>

          <div className="homepage-divider">
            <span>OR</span>
          </div>

          <div className="homepage-card">
            <div className="card-icon join">
              <LogIn size={28} />
            </div>
            <h3 className="card-title">Join Meeting</h3>
            <p className="card-description">
              Enter a meeting ID to join an existing meeting
            </p>
            <div className="join-meeting-form">
              <input
                type="text"
                value={meetingId}
                onChange={(e) => {
                  setMeetingId(e.target.value);
                  setError('');
                }}
                placeholder="Enter meeting ID"
                className="meeting-input"
              />
              <button
                onClick={handleJoinMeeting}
                className="btn btn-primary w-full"
              >
                Join Meeting
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="homepage-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

export default Homepage;