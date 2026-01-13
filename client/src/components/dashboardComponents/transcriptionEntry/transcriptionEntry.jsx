import './style.css';

// Helper: Format meeting time (seconds to MM:SS or H:MM:SS)
const formatMeetingTime = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

const TranscriptionEntry = ({ entry, isOwnEntry }) => {
  return (
    <div className={`transcription-entry ${isOwnEntry ? 'own' : 'other'}`}>
      <div className="entry-header">
        <span className="entry-time">
          [{formatMeetingTime(entry.secondsIntoMeeting)}]
        </span>
        <span className="entry-user">{entry.userName}:</span>
      </div>
      <div className="entry-text">{entry.text}</div>
      {entry.confidence && entry.confidence < 0.7 && (
        <div className="entry-confidence-warning" title="Low confidence transcription">
          <span className="confidence-icon">⚠️</span>
          <span className="confidence-text">May not be accurate</span>
        </div>
      )}
    </div>
  );
};

export default TranscriptionEntry;