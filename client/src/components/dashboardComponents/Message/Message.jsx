import { useState } from 'react';
import { MoreVertical, Edit2, Trash2, Check, X } from 'lucide-react';
import './style.css';

const Message = ({ message, isOwnMessage, onEdit, onDelete }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const handleEdit = () => {
    if (editContent.trim() && editContent !== message.content) {
      onEdit(message._id, editContent.trim());
      setIsEditing(false);
      setShowMenu(false);
    }
  };

  const handleCancelEdit = () => {
    setEditContent(message.content);
    setIsEditing(false);
    setShowMenu(false);
  };

  const handleDelete = () => {
    if (window.confirm('Are you sure you want to delete this message?')) {
      onDelete(message._id);
      setShowMenu(false);
    }
  };

  const getInitials = (name) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  return (
    <div className={`message-wrapper ${isOwnMessage ? 'own-message' : 'other-message'}`}>
      {!isOwnMessage && (
        <div className="message-avatar">
          {getInitials(message.userName)}
        </div>
      )}
      
      <div className="message-content-wrapper">
        {!isOwnMessage && (
          <div className="message-sender-name">{message.userName}</div>
        )}
        
        <div className="message-bubble-container">
          <div className={`message-bubble ${isOwnMessage ? 'own' : 'other'}`}>
            {isEditing ? (
              <div className="message-edit-form">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="message-edit-input"
                  autoFocus
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleEdit();
                    }
                    if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <div className="message-edit-actions">
                  <button onClick={handleEdit} className="edit-action-btn save">
                    <Check size={14} />
                    Save
                  </button>
                  <button onClick={handleCancelEdit} className="edit-action-btn cancel">
                    <X size={14} />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="message-text">{message.content}</p>
                <div className="message-meta">
                  <span className="message-time">{formatTime(message.timestamp)}</span>
                  {message.isEdited && <span className="message-edited">(edited)</span>}
                </div>
              </>
            )}
          </div>

          {isOwnMessage && !isEditing && (
            <div className="message-actions">
              <button
                className="message-menu-btn"
                onClick={() => setShowMenu(!showMenu)}
                title="Message options"
              >
                <MoreVertical size={16} />
              </button>
              
              {showMenu && (
                <div className="message-menu">
                  <button onClick={() => setIsEditing(true)} className="menu-item">
                    <Edit2 size={14} />
                    Edit
                  </button>
                  <button onClick={handleDelete} className="menu-item delete">
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Message;