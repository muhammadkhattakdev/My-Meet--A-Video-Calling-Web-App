import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import meetingRoutes from './routes/meeting.js';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

// Socket.io setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'MyMeet server is running' });
});

// Store active rooms and their participants
const rooms = new Map();

// WebRTC Signaling with Socket.io
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join a meeting room
  socket.on('join-room', ({ roomId, userId, userName }) => {
    console.log(`User ${userName} (${userId}) joining room ${roomId}`);
    
    socket.join(roomId);
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    
    const room = rooms.get(roomId);
    room.set(socket.id, { userId, userName, socketId: socket.id });
    
    // Get all other participants in the room
    const otherParticipants = Array.from(room.values()).filter(
      (p) => p.socketId !== socket.id
    );
    
    // Notify the new user about existing participants
    socket.emit('existing-participants', otherParticipants);
    
    // Notify other participants about the new user
    socket.to(roomId).emit('user-joined', {
      userId,
      userName,
      socketId: socket.id,
    });
  });

  // WebRTC Offer
  socket.on('offer', ({ offer, to, from, userName }) => {
    console.log(`Sending offer from ${from} to ${to}`);
    io.to(to).emit('offer', { offer, from, userName });
  });

  // WebRTC Answer
  socket.on('answer', ({ answer, to, from }) => {
    console.log(`Sending answer from ${from} to ${to}`);
    io.to(to).emit('answer', { answer, from });
  });

  // ICE Candidate
  socket.on('ice-candidate', ({ candidate, to, from }) => {
    console.log(`Sending ICE candidate from ${from} to ${to}`);
    io.to(to).emit('ice-candidate', { candidate, from });
  });

  // Toggle mic/camera status
  socket.on('toggle-media', ({ roomId, type, enabled }) => {
    socket.to(roomId).emit('user-media-toggle', {
      socketId: socket.id,
      type,
      enabled,
    });
  });

  // Recording status
  socket.on('recording-status', ({ roomId, isRecording }) => {
    socket.to(roomId).emit('recording-status-changed', {
      isRecording,
      userId: socket.id,
    });
  });

  // Chat messages
  socket.on('send-message', ({ roomId, message, userName }) => {
    io.to(roomId).emit('receive-message', {
      message,
      userName,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  // Leave room
  socket.on('leave-room', ({ roomId }) => {
    handleUserLeave(socket, roomId);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Find and remove user from all rooms
    rooms.forEach((room, roomId) => {
      if (room.has(socket.id)) {
        handleUserLeave(socket, roomId);
      }
    });
  });

  // Helper function to handle user leaving
  function handleUserLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (room) {
      const userData = room.get(socket.id);
      room.delete(socket.id);
      
      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(roomId);
      }
      
      // Notify other participants
      socket.to(roomId).emit('user-left', {
        socketId: socket.id,
        userName: userData?.userName,
      });
      
      socket.leave(roomId);
    }
  }
});

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// Start server
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
  httpServer.close(() => process.exit(1));
});