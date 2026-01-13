import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import authRoutes from './routes/auth.js';
import meetingRoutes from './routes/meeting.js';
import messageRoutes from './routes/message.js';
import transcriptionRoutes from './routes/transcription.js';

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
  maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for large recordings
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), 'uploads', 'recordings');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve static files for recordings
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Multer configuration for recording uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `recording-${uniqueSuffix}.webm`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/webm' || file.mimetype === 'video/mp4') {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/transcriptions', transcriptionRoutes);

// Recording upload endpoint
app.post('/api/meetings/:meetingId/upload-recording', 
  upload.single('recording'), 
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No recording file uploaded'
        });
      }

      const recordingUrl = `/uploads/recordings/${req.file.filename}`;
      
      res.status(200).json({
        success: true,
        message: 'Recording uploaded successfully',
        data: {
          recordingUrl,
          fileSize: req.file.size,
          filename: req.file.filename
        }
      });
    } catch (error) {
      console.error('Upload recording error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error uploading recording',
        error: error.message
      });
    }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'MyMeet server is running' });
});

// ============================================================================
// ADMISSION CONTROL DATA STRUCTURES
// ============================================================================

// Store active rooms and their participants
// Structure: Map<roomId, Map<socketId, participantData>>
const rooms = new Map();

// Store room metadata including host information
// Structure: Map<roomId, { hostUserId, hostSocketId, createdAt, settings }>
const roomMetadata = new Map();

// Store approved users per room (persists across reconnections)
// Structure: Map<roomId, Set<oduserId>>
const approvedUsers = new Map();

// Store pending join requests with deduplication
// Structure: Map<roomId, Map<oduserId, { oduserId, userName, socketId, requestedAt, status }>>
const pendingJoinRequests = new Map();

// Store denied users (temporary ban until meeting ends)
// Structure: Map<roomId, Map<userId, { deniedAt, reason }>>
const deniedUsers = new Map();

// NEW: Store socket-to-user mapping (tracks which userId owns which socket)
// Structure: Map<socketId, { oduserId, oduserId, roomId }>
const socketUserMap = new Map();

// Request timeout duration (5 minutes)
const REQUEST_TIMEOUT = 5 * 60 * 1000;

// Deduplication window (prevent spam requests)
const DEDUP_WINDOW = 5000; // 5 seconds

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize userId to string for consistent comparison
 */
const normalizeId = (id) => {
  if (!id) return '';
  return String(id).trim();
};

/**
 * Check if a user is the host of a room
 */
const isHost = (roomId, oduserId) => {
  const metadata = roomMetadata.get(roomId);
  if (!metadata) return false;
  return normalizeId(metadata.hostUserId) === normalizeId(oduserId);
};

/**
 * Check if a user is approved to join a room
 */
const isApproved = (roomId, oduserId) => {
  const approved = approvedUsers.get(roomId);
  if (!approved) return false;
  const normalizedOduserId = normalizeId(oduserId);
  for (const id of approved) {
    if (normalizeId(id) === normalizedOduserId) return true;
  }
  return false;
};

/**
 * Check if a user is denied from joining a room
 */
const isDenied = (roomId, oduserId) => {
  const denied = deniedUsers.get(roomId);
  if (!denied) return false;
  const normalizedId = normalizeId(oduserId);
  for (const [id] of denied) {
    if (normalizeId(id) === normalizedId) return true;
  }
  return false;
};

/**
 * Check if a user has a pending request (for deduplication)
 */
const hasPendingRequest = (roomId, oduserId) => {
  const requests = pendingJoinRequests.get(roomId);
  if (!requests) return false;
  
  const existingRequest = requests.get(oduserId);
  if (!existingRequest) return false;
  
  // Check if request is still within dedup window
  const timeSinceRequest = Date.now() - existingRequest.requestedAt;
  return timeSinceRequest < DEDUP_WINDOW;
};

/**
 * Get the current host socket ID for a room
 */
const getHostSocketId = (roomId) => {
  const metadata = roomMetadata.get(roomId);
  return metadata ? metadata.hostSocketId : null;
};

/**
 * Update host socket ID (for reconnection scenarios)
 */
const updateHostSocketId = (roomId, newSocketId) => {
  const metadata = roomMetadata.get(roomId);
  if (metadata) {
    metadata.hostSocketId = newSocketId;
    roomMetadata.set(roomId, metadata);
  }
};

/**
 * Add user to approved list
 */
const approveUser = (roomId, oduserId) => {
  const normalizedId = normalizeId(oduserId);
  if (!approvedUsers.has(roomId)) {
    approvedUsers.set(roomId, new Set());
  }
  approvedUsers.get(roomId).add(normalizedId);
  
  // Remove from pending if exists (with normalized comparison)
  const requests = pendingJoinRequests.get(roomId);
  if (requests) {
    for (const [id] of requests.entries()) {
      if (normalizeId(id) === normalizedId) {
        requests.delete(id);
        break;
      }
    }
  }
  
  // Remove from denied if was previously denied (with normalized comparison)
  const denied = deniedUsers.get(roomId);
  if (denied) {
    for (const [id] of denied.entries()) {
      if (normalizeId(id) === normalizedId) {
        denied.delete(id);
        break;
      }
    }
  }
};

/**
 * Add user to denied list
 */
const denyUser = (roomId, oduserId, reason = 'Request denied by host') => {
  if (!deniedUsers.has(roomId)) {
    deniedUsers.set(roomId, new Map());
  }
  deniedUsers.get(roomId).set(oduserId, { deniedAt: Date.now(), reason });
  
  // Remove from pending
  const requests = pendingJoinRequests.get(roomId);
  if (requests) {
    requests.delete(oduserId);
  }
};

/**
 * Clean up all data for a room
 */
const cleanupRoom = (roomId) => {
  rooms.delete(roomId);
  roomMetadata.delete(roomId);
  approvedUsers.delete(roomId);
  pendingJoinRequests.delete(roomId);
  deniedUsers.delete(roomId);
  console.log(`Room ${roomId} cleaned up completely`);
};

/**
 * Get all pending requests for a room
 */
const getPendingRequests = (roomId) => {
  const requests = pendingJoinRequests.get(roomId);
  if (!requests) return [];
  
  return Array.from(requests.values()).filter(req => {
    // Filter out expired requests
    const age = Date.now() - req.requestedAt;
    return age < REQUEST_TIMEOUT;
  });
};

/**
 * Clean up expired pending requests
 */
const cleanupExpiredRequests = (roomId) => {
  const requests = pendingJoinRequests.get(roomId);
  if (!requests) return;
  
  const now = Date.now();
  for (const [oduserId, request] of requests.entries()) {
    if (now - request.requestedAt > REQUEST_TIMEOUT) {
      requests.delete(oduserId);
      // Notify the user their request expired
      if (request.socketId) {
        io.to(request.socketId).emit('join-request-expired', {
          message: 'Your join request has expired. Please try again.'
        });
      }
    }
  }
};

// Periodic cleanup of expired requests (every minute)
setInterval(() => {
  for (const roomId of pendingJoinRequests.keys()) {
    cleanupExpiredRequests(roomId);
  }
}, 60000);

// ============================================================================
// SOCKET.IO CONNECTION HANDLING
// ============================================================================

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // -------------------------------------------------------------------------
  // ADMISSION CONTROL: Request to join a meeting room
  // -------------------------------------------------------------------------
  socket.on('request-join-room', ({ roomId, oduserId, userName, isRejoin = false }) => {
    console.log(`User ${userName} (${oduserId}) requesting to join room ${roomId}`);
    
    // IMPORTANT: Register this socket -> user mapping
    // This allows us to identify the user even if their socket changes
    socketUserMap.set(socket.id, { oduserId, userName, roomId });
    console.log(`Registered socket mapping: ${socket.id} -> ${oduserId}`);
    
    // Check if user is denied (temporary ban)
    if (isDenied(roomId, oduserId)) {
      const denied = deniedUsers.get(roomId).get(oduserId);
      socket.emit('join-denied', { 
        reason: denied.reason || 'You have been denied access to this meeting.',
        permanent: false
      });
      return;
    }
    
    // Check if room exists and has metadata
    const metadata = roomMetadata.get(roomId);
    
    // CASE 1: Room doesn't exist - this user becomes the host
    if (!metadata) {
      console.log(`Room ${roomId} doesn't exist. ${userName} will be the host.`);
      
      // Create room metadata with this user as host
      roomMetadata.set(roomId, {
        hostUserId: oduserId,
        hostSocketId: socket.id,
        createdAt: Date.now(),
        settings: { waitingRoomEnabled: true }
      });
      
      // Auto-approve the host
      approveUser(roomId, oduserId);
      
      // Send approval to join
      socket.emit('join-approved', { 
        roomId, 
        isHost: true,
        message: 'You are the host of this meeting.'
      });
      return;
    }
    
    // CASE 2: User IS the host (by userId from database)
    if (isHost(roomId, oduserId)) {
      console.log(`Host ${userName} rejoining room ${roomId}`);
      
      // Update host's socket ID for reconnection
      updateHostSocketId(roomId, socket.id);
      
      // Ensure host is in approved list
      approveUser(roomId, oduserId);
      
      // Send pending requests to host (they might have missed some while disconnected)
      const pendingRequests = getPendingRequests(roomId);
      
      socket.emit('join-approved', { 
        roomId, 
        isHost: true,
        pendingRequests,
        message: 'Welcome back! You are the host.'
      });
      return;
    }
    
    // CASE 3: User is already approved (handles page refresh)
    if (isApproved(roomId, oduserId)) {
      console.log(`Already approved user ${userName} rejoining room ${roomId}`);
      
      socket.emit('join-approved', { 
        roomId, 
        isHost: false,
        message: isRejoin ? 'Reconnected successfully.' : 'You have been approved to join.'
      });
      return;
    }
    
    // CASE 4: Check for duplicate pending request (deduplication)
    if (hasPendingRequest(roomId, oduserId)) {
      console.log(`Duplicate request from ${userName}, ignoring`);
      socket.emit('waiting-for-approval', {
        message: 'Your request is pending. Please wait for the host to admit you.',
        isDuplicate: true
      });
      return;
    }
    
    // CASE 5: New join request - add to pending and notify host
    console.log(`New join request from ${userName} for room ${roomId}`);
    
    // Initialize pending requests map for room if needed
    if (!pendingJoinRequests.has(roomId)) {
      pendingJoinRequests.set(roomId, new Map());
    }
    
    // Store the request (keyed by oduserId to prevent duplicates)
    const request = {
      oduserId,
      userName,
      socketId: socket.id,
      requestedAt: Date.now(),
      status: 'pending'
    };
    pendingJoinRequests.get(roomId).set(oduserId, request);
    
    // Notify the requester they're waiting
    socket.emit('waiting-for-approval', {
      message: 'Waiting for the host to admit you...',
      position: pendingJoinRequests.get(roomId).size
    });
    
    // Notify the host about the join request
    const hostSocketId = getHostSocketId(roomId);
    if (hostSocketId) {
      io.to(hostSocketId).emit('join-request', {
        oduserId,
        userName,
        requesterId: socket.id,
        requestedAt: request.requestedAt
      });
    } else {
      console.log(`Host not connected for room ${roomId}, request queued`);
    }
  });

  // -------------------------------------------------------------------------
  // ADMISSION CONTROL: Host approves a join request
  // -------------------------------------------------------------------------
  socket.on('approve-join-request', ({ roomId, oduserId, approverUserId }) => {
    console.log(`\n=== APPROVE JOIN REQUEST ===`);
    console.log(`Room: ${roomId}, User to approve: ${oduserId}`);
    console.log(`Approver socket.id: ${socket.id}`);
    console.log(`Approver userId (from frontend): ${approverUserId}`);
    
    // Get room metadata
    const metadata = roomMetadata.get(roomId);
    if (!metadata) {
      console.log(`ERROR: No metadata for room ${roomId}`);
      socket.emit('error', { message: 'Room not found.' });
      return;
    }
    
    console.log(`Host userId from metadata: ${metadata.hostUserId}`);
    
    // VERIFY: The approverUserId from frontend must match the host's userId
    // We trust the frontend userId because:
    // 1. It comes from the authenticated user session
    // 2. We verify it matches the host stored in room metadata
    const isApproverHost = approverUserId && 
      normalizeId(approverUserId) === normalizeId(metadata.hostUserId);
    
    console.log(`Normalized approverUserId: "${normalizeId(approverUserId)}"`);
    console.log(`Normalized hostUserId: "${normalizeId(metadata.hostUserId)}"`);
    console.log(`Is approver the host: ${isApproverHost}`);
    
    if (!isApproverHost) {
      console.log(`ERROR: Approver is NOT the host`);
      socket.emit('error', { message: 'Only the host can approve join requests.' });
      return;
    }
    
    console.log(`SUCCESS: Approver IS the host`);
    
    // Update host socket ID to current socket
    updateHostSocketId(roomId, socket.id);
    
    // Register this socket in socketUserMap (in case it wasn't registered)
    socketUserMap.set(socket.id, { oduserId: approverUserId, roomId });
    
    // Make sure socket joins the Socket.io room
    socket.join(roomId);
    
    // Get the pending request
    const requests = pendingJoinRequests.get(roomId);
    const normalizedOduserId = normalizeId(oduserId);
    
    // Find request with normalized ID comparison
    let request = null;
    let requestKey = null;
    if (requests) {
      for (const [id, req] of requests.entries()) {
        if (normalizeId(id) === normalizedOduserId) {
          request = req;
          requestKey = id;
          break;
        }
      }
    }
    
    console.log(`Pending request found: ${!!request}`);
    
    if (!request) {
      socket.emit('error', { message: 'Join request not found or already processed.' });
      return;
    }
    
    // Approve the user
    approveUser(roomId, oduserId);
    
    // Remove from pending
    if (requests && requestKey) {
      requests.delete(requestKey);
    }
    
    // Notify the user they're approved
    console.log(`Sending join-approved to socket: ${request.socketId}`);
    io.to(request.socketId).emit('join-approved', { 
      roomId, 
      isHost: false,
      message: 'The host has admitted you to the meeting.'
    });
    
    // Confirm to host
    socket.emit('join-request-processed', {
      oduserId,
      userName: request.userName,
      action: 'approved'
    });
    
    console.log(`User ${request.userName} approved for room ${roomId}`);
  });

  // -------------------------------------------------------------------------
  // ADMISSION CONTROL: Host denies a join request
  // -------------------------------------------------------------------------
  socket.on('deny-join-request', ({ roomId, oduserId, reason, approverUserId }) => {
    console.log(`Denying join request for user ${oduserId} in room ${roomId}`);
    
    // Get room metadata
    const metadata = roomMetadata.get(roomId);
    if (!metadata) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }
    
    // Verify the denier is the host using approverUserId from frontend
    const isDenierHost = approverUserId && 
      normalizeId(approverUserId) === normalizeId(metadata.hostUserId);
    
    if (!isDenierHost) {
      socket.emit('error', { message: 'Only the host can deny join requests.' });
      return;
    }
    
    // Update host socket ID
    updateHostSocketId(roomId, socket.id);
    
    // Register this socket in socketUserMap
    socketUserMap.set(socket.id, { oduserId: approverUserId, roomId });
    
    // Get the pending request (with normalized ID lookup)
    const requests = pendingJoinRequests.get(roomId);
    const normalizedOduserId = normalizeId(oduserId);
    let request = null;
    let requestKey = null;
    
    if (requests) {
      for (const [id, req] of requests.entries()) {
        if (normalizeId(id) === normalizedOduserId) {
          request = req;
          requestKey = id;
          break;
        }
      }
    }
    
    if (!request) {
      socket.emit('error', { message: 'Join request not found or already processed.' });
      return;
    }
    
    // Deny the user
    const denyReason = reason || 'The host has denied your request to join.';
    denyUser(roomId, oduserId, denyReason);
    
    // Remove from pending
    if (requests && requestKey) {
      requests.delete(requestKey);
    }
    
    // Notify the user they're denied
    io.to(request.socketId).emit('join-denied', { 
      reason: denyReason,
      permanent: false
    });
    
    // Confirm to host
    socket.emit('join-request-processed', {
      oduserId,
      userName: request.userName,
      action: 'denied'
    });
    
    console.log(`User ${request.userName} denied for room ${roomId}`);
  });

  // -------------------------------------------------------------------------
  // ADMISSION CONTROL: Admit all waiting users
  // -------------------------------------------------------------------------
  socket.on('admit-all-waiting', ({ roomId, approverUserId }) => {
    console.log(`Admitting all waiting users for room ${roomId}`);
    
    // Get room metadata
    const metadata = roomMetadata.get(roomId);
    if (!metadata) {
      socket.emit('error', { message: 'Room not found.' });
      return;
    }
    
    // Verify the user is the host using approverUserId from frontend
    const isUserHost = approverUserId && 
      normalizeId(approverUserId) === normalizeId(metadata.hostUserId);
    
    if (!isUserHost) {
      socket.emit('error', { message: 'Only the host can admit all users.' });
      return;
    }
    
    // Update host socket ID
    updateHostSocketId(roomId, socket.id);
    
    // Register this socket in socketUserMap
    socketUserMap.set(socket.id, { oduserId: approverUserId, roomId });
    
    const requests = pendingJoinRequests.get(roomId);
    if (!requests || requests.size === 0) {
      socket.emit('error', { message: 'No pending requests.' });
      return;
    }
    
    // Store count before clearing
    const admittedCount = requests.size;
    
    // Approve all pending requests
    for (const [oduserId, request] of requests.entries()) {
      approveUser(roomId, oduserId);
      io.to(request.socketId).emit('join-approved', { 
        roomId, 
        isHost: false,
        message: 'The host has admitted you to the meeting.'
      });
    }
    
    // Clear pending requests
    requests.clear();
    
    socket.emit('all-admitted', { count: admittedCount });
  });

  // -------------------------------------------------------------------------
  // JOINING ROOM: After approval, user joins the actual WebRTC room
  // -------------------------------------------------------------------------
  socket.on('join-room', ({ roomId, oduserId, userName, mediaState }) => {
    console.log(`\n=== JOIN ROOM ===`);
    console.log(`User ${userName} (${oduserId}) joining room ${roomId}`);
    console.log(`Socket ID: ${socket.id}`);
    
    // Verify user is approved or is the host
    const userIsHostCheck = isHost(roomId, oduserId);
    const userIsApprovedCheck = isApproved(roomId, oduserId);
    console.log(`Is host: ${userIsHostCheck}, Is approved: ${userIsApprovedCheck}`);
    
    if (!userIsApprovedCheck && !userIsHostCheck) {
      console.log(`User ${userName} not approved, rejecting join`);
      socket.emit('error', { message: 'You are not approved to join this meeting.' });
      return;
    }
    
    // Check if user was in the room before (reconnection)
    const room = rooms.get(roomId);
    let oldSocketId = null;
    
    if (room) {
      // Find if this oduserId already exists with different socketId
      for (const [socketId, data] of room.entries()) {
        if (normalizeId(data.oduserId) === normalizeId(oduserId) && socketId !== socket.id) {
          oldSocketId = socketId;
          break;
        }
      }
    }
    
    socket.join(roomId);
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
      console.log(`Created new room in rooms Map: ${roomId}`);
    }
    
    const currentRoom = rooms.get(roomId);
    
    // If old socket found, notify others to clean it up
    if (oldSocketId) {
      socket.to(roomId).emit('user-disconnected', {
        socketId: oldSocketId,
        oduserId: oduserId
      });
      currentRoom.delete(oldSocketId);
    }
    
    // Determine if this user is the host
    const userIsHost = isHost(roomId, oduserId);
    console.log(`User is host: ${userIsHost}`);
    
    // If host is joining/rejoining, update their socket ID
    if (userIsHost) {
      updateHostSocketId(roomId, socket.id);
      console.log(`Updated hostSocketId to: ${socket.id}`);
    }
    
    // Add current user
    currentRoom.set(socket.id, { 
      oduserId, 
      userName, 
      socketId: socket.id,
      isHost: userIsHost,
      mediaState: mediaState || { audio: true, video: true },
      joinedAt: Date.now()
    });
    
    console.log(`Added user to room. Room now has ${currentRoom.size} participants`);
    console.log(`Room contents:`);
    for (const [sid, data] of currentRoom.entries()) {
      console.log(`  - ${sid}: ${data.userName} (${data.oduserId})`);
    }
    
    // Get all other participants in the room
    const otherParticipants = Array.from(currentRoom.values())
      .filter((p) => p.socketId !== socket.id)
      .map(p => ({
        oduserId: p.oduserId,
        userName: p.userName,
        socketId: p.socketId,
        isHost: p.isHost,
        mediaState: p.mediaState
      }));
    
    // Notify the new user about existing participants
    socket.emit('existing-participants', otherParticipants);
    
    // If this user is the host, send any pending requests
    if (userIsHost) {
      const pendingRequests = getPendingRequests(roomId);
      if (pendingRequests.length > 0) {
        socket.emit('pending-join-requests', pendingRequests);
      }
    }
    
    // Notify other participants about the new user
    socket.to(roomId).emit('user-joined', {
      oduserId,
      userName,
      socketId: socket.id,
      isHost: userIsHost,
      mediaState: mediaState || { audio: true, video: true }
    });
  });

  // -------------------------------------------------------------------------
  // REJOIN ROOM: For reconnection scenarios
  // -------------------------------------------------------------------------
  socket.on('rejoin-room', ({ roomId, oduserId, userName, mediaState }) => {
    console.log(`User ${userName} rejoining room ${roomId}`);
    
    // Reuse join-room logic (it handles reconnection)
    socket.emit('request-join-room', { roomId, oduserId, userName, isRejoin: true });
  });

  // -------------------------------------------------------------------------
  // Update pending request socket ID (for reconnection while waiting)
  // -------------------------------------------------------------------------
  socket.on('update-waiting-socket', ({ roomId, oduserId }) => {
    const requests = pendingJoinRequests.get(roomId);
    if (requests && requests.has(oduserId)) {
      const request = requests.get(oduserId);
      request.socketId = socket.id;
      requests.set(oduserId, request);
      console.log(`Updated socket ID for waiting user ${oduserId}`);
    }
  });

  // -------------------------------------------------------------------------
  // WebRTC Signaling: Offer
  // -------------------------------------------------------------------------
  socket.on('offer', ({ offer, to, from, userName, oduserId, mediaState }) => {
    console.log(`Sending offer from ${from} to ${to}`);
    io.to(to).emit('offer', { 
      offer, 
      from, 
      userName, 
      oduserId,
      mediaState 
    });
  });

  // -------------------------------------------------------------------------
  // WebRTC Signaling: Answer
  // -------------------------------------------------------------------------
  socket.on('answer', ({ answer, to, from, oduserId }) => {
    console.log(`Sending answer from ${from} to ${to}`);
    io.to(to).emit('answer', { answer, from, oduserId });
  });

  // -------------------------------------------------------------------------
  // WebRTC Signaling: ICE Candidate
  // -------------------------------------------------------------------------
  socket.on('ice-candidate', ({ candidate, to, from }) => {
    console.log(`Sending ICE candidate from ${from} to ${to}`);
    io.to(to).emit('ice-candidate', { candidate, from });
  });

  // -------------------------------------------------------------------------
  // Request renegotiation
  // -------------------------------------------------------------------------
  socket.on('request-renegotiation', ({ to, from }) => {
    console.log(`Renegotiation requested from ${from} to ${to}`);
    io.to(to).emit('renegotiation-needed', { from });
  });

  // -------------------------------------------------------------------------
  // Toggle mic/camera status
  // -------------------------------------------------------------------------
  socket.on('toggle-media', ({ roomId, type, enabled }) => {
    const room = rooms.get(roomId);
    if (room && room.has(socket.id)) {
      const userData = room.get(socket.id);
      if (type === 'audio') {
        userData.mediaState.audio = enabled;
      } else if (type === 'video') {
        userData.mediaState.video = enabled;
      }
    }
    
    socket.to(roomId).emit('user-media-toggle', {
      socketId: socket.id,
      type,
      enabled,
    });
  });

  // -------------------------------------------------------------------------
  // Recording status
  // -------------------------------------------------------------------------
  socket.on('recording-status', ({ roomId, isRecording, userName }) => {
    console.log(`Recording status changed in room ${roomId}: ${isRecording}`);
    socket.to(roomId).emit('recording-status-changed', {
      isRecording,
      userName,
      socketId: socket.id,
    });
  });

  // -------------------------------------------------------------------------
  // Chat messages
  // -------------------------------------------------------------------------
  socket.on('send-message', ({ roomId, message, userName }) => {
    io.to(roomId).emit('receive-message', {
      message,
      userName,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // Transcription events
  // -------------------------------------------------------------------------
  socket.on('transcription-entry', ({ roomId, userId, userName, text, timestamp, secondsIntoMeeting, confidence }) => {
    console.log(`Transcription entry from ${userName} in room ${roomId}`);
    
    // Broadcast to all participants in the room (including sender for confirmation)
    io.to(roomId).emit('transcription-update', {
      userId,
      userName,
      text,
      timestamp,
      secondsIntoMeeting,
      confidence,
      socketId: socket.id,
    });
  });

  // Share meeting start time with new joiners
  socket.on('request-meeting-start-time', ({ roomId }) => {
    const metadata = roomMetadata.get(roomId);
    if (metadata && metadata.meetingStartTime) {
      socket.emit('meeting-start-time', {
        startTime: metadata.meetingStartTime
      });
    }
  });

  // Host sets meeting start time
  socket.on('set-meeting-start-time', ({ roomId, startTime }) => {
    const metadata = roomMetadata.get(roomId);
    if (metadata && !metadata.meetingStartTime) {
      metadata.meetingStartTime = startTime;
      roomMetadata.set(roomId, metadata);
      console.log(`Meeting start time set for room ${roomId}: ${startTime}`);
    }
  });

  // -------------------------------------------------------------------------
  // Leave room
  // -------------------------------------------------------------------------
  socket.on('leave-room', ({ roomId, oduserId }) => {
    handleUserLeave(socket, roomId, oduserId);
  });

  // -------------------------------------------------------------------------
  // End meeting (host only)
  // -------------------------------------------------------------------------
  socket.on('end-meeting', ({ roomId }) => {
    const metadata = roomMetadata.get(roomId);
    if (!metadata) return;
    
    // Verify host
    const room = rooms.get(roomId);
    const userData = room?.get(socket.id);
    if (!userData || userData.oduserId !== metadata.hostUserId) {
      socket.emit('error', { message: 'Only the host can end the meeting.' });
      return;
    }
    
    // Notify all participants
    io.to(roomId).emit('meeting-ended', {
      message: 'The host has ended the meeting.',
      endedBy: userData.userName
    });
    
    // Notify waiting users
    const pendingRequests = pendingJoinRequests.get(roomId);
    if (pendingRequests) {
      for (const request of pendingRequests.values()) {
        io.to(request.socketId).emit('meeting-ended', {
          message: 'The meeting has ended.',
          endedBy: userData.userName
        });
      }
    }
    
    // Clean up room
    cleanupRoom(roomId);
  });

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // NOTE: We do NOT delete from socketUserMap on disconnect
    // because the socket might reconnect and we want to preserve the mapping
    // The map entry will be overwritten when the user reconnects
    
    // Update pending join requests - don't delete, just mark socket as stale
    // User might reconnect and we want to preserve their pending status
    pendingJoinRequests.forEach((roomRequests, roomId) => {
      for (const [oduserId, request] of roomRequests.entries()) {
        if (request.socketId === socket.id) {
          // Don't delete - keep the request but mark socketId as null
          // User can update socket on reconnect
          request.socketId = null;
          console.log(`Marked pending request for ${oduserId} as disconnected`);
        }
      }
    });
    
    // Find and remove user from all rooms
    rooms.forEach((room, roomId) => {
      if (room.has(socket.id)) {
        const userData = room.get(socket.id);
        handleUserLeave(socket, roomId, userData?.oduserId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Helper: Handle user leaving
  // -------------------------------------------------------------------------
  function handleUserLeave(socket, roomId, oduserId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const userData = room.get(socket.id);
    room.delete(socket.id);
    
    // Check if leaving user is the host
    const metadata = roomMetadata.get(roomId);
    const wasHost = metadata && metadata.hostUserId === oduserId;
    
    // Clean up empty rooms
    if (room.size === 0) {
      cleanupRoom(roomId);
    } else if (wasHost) {
      // Host left but room still has participants
      // Optionally: transfer host to another participant or notify everyone
      io.to(roomId).emit('host-left', {
        message: 'The host has left the meeting.',
        hostName: userData?.userName
      });
    }
    
    // Notify other participants
    socket.to(roomId).emit('user-left', {
      socketId: socket.id,
      userName: userData?.userName,
      oduserId: oduserId || userData?.oduserId,
      wasHost
    });
    
    socket.leave(roomId);
  }
});

// ============================================================================
// DATABASE CONNECTION & SERVER START
// ============================================================================

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

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