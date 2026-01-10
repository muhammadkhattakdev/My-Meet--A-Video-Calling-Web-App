import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, Loader2 } from 'lucide-react';
import './style.css';
import Message from '../Message/Message';
import api from '../../request';

const RoomMessaging = ({ meetingId, userId, userName, socketRef, isOpen, setIsOpen, onUnreadCountChange }) => {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const messagesEndRef = useRef(null);
  const messageContainerRef = useRef(null);
  const inputRef = useRef(null);

  // Scroll to bottom of messages
  const scrollToBottom = (smooth = true) => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'end',
      });
    }
  };

  // Load messages when opening
  useEffect(() => {
    if (isOpen) {
      loadMessages();
      setUnreadCount(0);
      
      // Focus input after opening animation
      setTimeout(() => {
        inputRef.current?.focus();
      }, 300);
    }
  }, [isOpen]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (isOpen && messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, isOpen]);

  // Socket event listeners
  useEffect(() => {
    if (!socketRef.current) return;

    const handleReceiveMessage = (data) => {
      // Don't add our own messages - they're already added via optimistic update
      if (data.userName === userName) {
        return;
      }

      const newMsg = {
        _id: `temp-${Date.now()}-${Math.random()}`,
        content: data.message,
        userName: data.userName,
        userId: data.socketId, // Using socketId as temporary userId
        timestamp: data.timestamp,
        isEdited: false,
      };

      setMessages((prev) => [...prev, newMsg]);

      // Increment unread count if chat is closed
      if (!isOpen) {
        setUnreadCount((prev) => prev + 1);
      }
    };

    socketRef.current.on('receive-message', handleReceiveMessage);

    return () => {
      if (socketRef.current) {
        socketRef.current.off('receive-message', handleReceiveMessage);
      }
    };
  }, [socketRef, isOpen, userName]);

  // Load messages from server
  const loadMessages = async () => {
    setIsLoading(true);
    try {
      const response = await api.get(`/api/messages/${meetingId}`);
      if (response.data.success) {
        setMessages(response.data.data.messages);
        setTimeout(() => scrollToBottom(false), 100);
      }
    } catch (err) {
      console.error('Error loading messages:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Send message
  const handleSendMessage = async () => {
    if (!newMessage.trim() || isSending) return;

    const messageContent = newMessage.trim();
    setNewMessage('');
    setIsSending(true);

    try {
      // Save to database
      const response = await api.post(`/api/messages/${meetingId}`, {
        content: messageContent,
      });

      if (response.data.success) {
        // Add to local state
        setMessages((prev) => [...prev, response.data.data.message]);

        // Emit via socket for real-time delivery to others
        if (socketRef.current) {
          socketRef.current.emit('send-message', {
            roomId: meetingId,
            message: messageContent,
            userName: userName,
          });
        }
      }
    } catch (err) {
      console.error('Error sending message:', err);
      // Restore message on error
      setNewMessage(messageContent);
    } finally {
      setIsSending(false);
    }
  };

  // Edit message
  const handleEditMessage = async (messageId, content) => {
    try {
      const response = await api.put(`/api/messages/${messageId}`, {
        content,
      });

      if (response.data.success) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg._id === messageId ? response.data.data.message : msg
          )
        );
      }
    } catch (err) {
      console.error('Error editing message:', err);
      alert('Failed to edit message. Please try again.');
    }
  };

  // Delete message
  const handleDeleteMessage = async (messageId) => {
    try {
      const response = await api.delete(`/api/messages/${messageId}`);

      if (response.data.success) {
        setMessages((prev) => prev.filter((msg) => msg._id !== messageId));
      }
    } catch (err) {
      console.error('Error deleting message:', err);
      alert('Failed to delete message. Please try again.');
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Toggle chat open/close
  const toggleChat = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setUnreadCount(0);
    }
  };

  // Notify parent of unread count changes
  useEffect(() => {
    if (onUnreadCountChange) {
      onUnreadCountChange(unreadCount);
    }
  }, [unreadCount, onUnreadCountChange]);

  return (
    <>
      {/* Chat window */}
      <div className={`room-messaging ${isOpen ? 'open' : 'closed'}`}>
        {/* Header */}
        <div className="room-messaging-header">
          <div className="header-left">
            <MessageCircle size={20} />
            <h3>Chat</h3>
          </div>
          <button onClick={toggleChat} className="close-chat-btn" title="Close chat">
            <X size={20} />
          </button>
        </div>

        {/* Messages container */}
        <div className="room-messaging-body" ref={messageContainerRef}>
          {isLoading ? (
            <div className="messages-loading">
              <Loader2 size={24} className="spin" />
              <p>Loading messages...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="messages-empty">
              <MessageCircle size={48} />
              <p>No messages yet</p>
              <span>Start the conversation!</span>
            </div>
          ) : (
            <div className="messages-list">
              {messages.map((message) => (
                <Message
                  key={message._id}
                  message={message}
                  isOwnMessage={message.userId === userId}
                  onEdit={handleEditMessage}
                  onDelete={handleDeleteMessage}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="room-messaging-footer">
          <div className="message-input-wrapper">
            <textarea
              ref={inputRef}
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="message-input"
              rows={1}
              maxLength={5000}
              disabled={isSending}
            />
            <button
              onClick={handleSendMessage}
              disabled={!newMessage.trim() || isSending}
              className="send-message-btn"
              title="Send message"
            >
              {isSending ? <Loader2 size={20} className="spin" /> : <Send size={20} />}
            </button>
          </div>
          <div className="message-input-hint">
            Press Enter to send, Shift+Enter for new line
          </div>
        </div>
      </div>
    </>
  );
};

export default RoomMessaging;