import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  Circle,
  PhoneOff,
  Copy,
  Check,
} from "lucide-react";
import { io } from "socket.io-client";
import "./style.css";
import api from "../../../request";
import { useApp } from "../../../../context/context";

// Constants
const MAX_RECONNECTION_ATTEMPTS = 5;
const RECONNECTION_DELAY = 2000;
const ICE_GATHERING_TIMEOUT = 10000;
const PEER_CONNECTION_TIMEOUT = 30000;

const MeetingRoom = () => {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const { user } = useApp();

  // Refs
  const localVideoRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const pendingCandidatesRef = useRef({});
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const reconnectionAttemptsRef = useRef(0);
  const isLeavingRef = useRef(false);
  const mixedStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const canvasRef = useRef(null);

  // State
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [isInitializing, setIsInitializing] = useState(true);
  const [connectionStates, setConnectionStates] = useState({});

  // Enhanced ICE servers with TURN fallback
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      // Add TURN servers if available
      // {
      //   urls: "turn:your-turn-server.com:3478",
      //   username: "username",
      //   credential: "password"
      // }
    ],
    iceCandidatePoolSize: 10,
  };

  // Initialize media stream
  useEffect(() => {
    const initializeMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          },
        });

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Initialize socket connection
        initializeSocket();
        setIsInitializing(false);
      } catch (err) {
        console.error("Error accessing media devices:", err);
        handleMediaError(err);
        setIsInitializing(false);
      }
    };

    initializeMedia();

    return () => {
      cleanup();
    };
  }, []);

  // Handle media errors with specific messages
  const handleMediaError = (err) => {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      setError("Camera/microphone access denied. Please grant permissions and reload.");
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      setError("No camera or microphone found. Please connect a device.");
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      setError("Camera/microphone is already in use by another application.");
    } else {
      setError("Failed to access camera/microphone. Please check your device settings.");
    }
  };

  // Comprehensive cleanup function
  const cleanup = useCallback(() => {
    isLeavingRef.current = true;

    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }

    // Stop local stream tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      localStreamRef.current = null;
    }

    // Close all peer connections
    Object.values(peerConnectionsRef.current).forEach((pc) => {
      if (pc && pc.close) {
        pc.close();
      }
    });
    peerConnectionsRef.current = {};

    // Clear pending candidates
    pendingCandidatesRef.current = {};

    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    // Clean up audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Clean up mixed stream
    if (mixedStreamRef.current) {
      mixedStreamRef.current.getTracks().forEach(track => track.stop());
      mixedStreamRef.current = null;
    }
  }, [isRecording]);

  // Initialize socket with reconnection logic
  const initializeSocket = () => {
    const socketUrl = import.meta.env.VITE_API_URL || "http://localhost:5000";
    
    socketRef.current = io(socketUrl, {
      reconnection: true,
      reconnectionAttempts: MAX_RECONNECTION_ATTEMPTS,
      reconnectionDelay: RECONNECTION_DELAY,
      timeout: 10000,
    });

    // Socket connection events
    socketRef.current.on("connect", handleSocketConnect);
    socketRef.current.on("disconnect", handleSocketDisconnect);
    socketRef.current.on("reconnect", handleSocketReconnect);
    socketRef.current.on("reconnect_failed", handleSocketReconnectFailed);

    // WebRTC signaling events
    socketRef.current.on("existing-participants", handleExistingParticipants);
    socketRef.current.on("user-joined", handleUserJoined);
    socketRef.current.on("offer", handleOfferReceived);
    socketRef.current.on("answer", handleAnswerReceived);
    socketRef.current.on("ice-candidate", handleIceCandidateReceived);
    socketRef.current.on("user-left", handleUserLeft);
    socketRef.current.on("user-disconnected", handleUserDisconnected);
    socketRef.current.on("user-media-toggle", handleUserMediaToggle);
    socketRef.current.on("renegotiation-needed", handleRenegotiationNeeded);
  };

  // Socket event handlers
  const handleSocketConnect = () => {
    console.log("Socket connected:", socketRef.current.id);
    reconnectionAttemptsRef.current = 0;
    setError("");

    // Join room
    socketRef.current.emit("join-room", {
      roomId: meetingId,
      userId: user.id,
      userName: user.fullName,
      mediaState: {
        audio: isAudioEnabled,
        video: isVideoEnabled,
      },
    });
  };

  const handleSocketDisconnect = (reason) => {
    console.log("Socket disconnected:", reason);
    
    if (isLeavingRef.current) return;

    setError("Connection lost. Attempting to reconnect...");
    
    // Mark all participants as disconnected
    setConnectionStates((prev) => {
      const newStates = { ...prev };
      Object.keys(newStates).forEach((id) => {
        newStates[id] = "disconnected";
      });
      return newStates;
    });
  };

  const handleSocketReconnect = (attemptNumber) => {
    console.log("Socket reconnected after", attemptNumber, "attempts");
    setError("");

    // Rejoin room and re-establish connections
    socketRef.current.emit("rejoin-room", {
      roomId: meetingId,
      userId: user.id,
      userName: user.fullName,
      mediaState: {
        audio: isAudioEnabled,
        video: isVideoEnabled,
      },
    });
  };

  const handleSocketReconnectFailed = () => {
    console.error("Socket reconnection failed");
    setError("Connection lost. Please refresh the page to rejoin the meeting.");
  };

  const handleExistingParticipants = async (existingParticipants) => {
    console.log("Existing participants:", existingParticipants);

    for (const participant of existingParticipants) {
      // Skip self
      if (participant.userId === user.id) continue;

      await createPeerConnection(
        participant.socketId,
        participant.userName,
        participant.userId,
        true
      );
    }
  };

  const handleUserJoined = async ({ socketId, userName, userId, mediaState }) => {
    console.log("User joined:", userName, socketId);

    // Prevent duplicate connections
    if (userId === user.id) return;

    // Clean up any existing connections for this userId (handles refresh)
    Object.entries(peerConnectionsRef.current).forEach(([oldSocketId, pc]) => {
      // Check if this is an old connection for the same user
      const existingParticipant = participants.find(p => p.socketId === oldSocketId);
      if (existingParticipant && existingParticipant.userId === userId && oldSocketId !== socketId) {
        console.log("Cleaning up old connection for refreshed user:", userName);
        removeParticipant(oldSocketId);
      }
    });

    await createPeerConnection(socketId, userName, userId, false);
  };

  const handleOfferReceived = async ({ offer, from, userName, userId }) => {
    console.log("Received offer from:", userName);
    await handleOffer(offer, from, userName, userId);
  };

  const handleAnswerReceived = async ({ answer, from }) => {
    console.log("Received answer from:", from);
    await handleAnswer(answer, from);
  };

  const handleIceCandidateReceived = async ({ candidate, from }) => {
    await handleIceCandidate(candidate, from);
  };

  const handleUserLeft = ({ socketId, userName, userId }) => {
    console.log("User left:", userName);
    removeParticipant(socketId);
  };

  const handleUserDisconnected = ({ socketId, userId }) => {
    console.log("User disconnected (old socket):", socketId);
    // Clean up old socket connection immediately
    removeParticipant(socketId);
    
    // Also remove any participants with this userId but different socketId
    // This handles the case where user refreshed and we have stale entries
    setParticipants((prev) => prev.filter((p) => 
      !(p.userId === userId && p.socketId !== socketId)
    ));
  };

  const handleUserMediaToggle = ({ socketId, type, enabled }) => {
    setParticipants((prev) =>
      prev.map((p) =>
        p.socketId === socketId
          ? {
              ...p,
              [type === "audio" ? "isAudioEnabled" : "isVideoEnabled"]: enabled,
            }
          : p
      )
    );
  };

  const handleRenegotiationNeeded = async ({ from, userName, userId }) => {
    console.log("Renegotiation needed for:", userName);
    const pc = peerConnectionsRef.current[from];
    if (pc && pc.signalingState === "stable") {
      await createAndSendOffer(pc, from);
    }
  };

  // Create peer connection with comprehensive error handling
  const createPeerConnection = async (socketId, userName, userId, isInitiator) => {
    // Prevent self-connection
    if (userId === user.id) {
      console.log("Skipping self-connection");
      return;
    }

    try {
      // Close existing connection if any (handles reconnection)
      if (peerConnectionsRef.current[socketId]) {
        console.log("Closing existing peer connection for:", userName);
        peerConnectionsRef.current[socketId].close();
        delete peerConnectionsRef.current[socketId];
      }

      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnectionsRef.current[socketId] = peerConnection;

      // Initialize pending candidates array
      pendingCandidatesRef.current[socketId] = [];

      // Update connection state
      setConnectionStates((prev) => ({ ...prev, [socketId]: "connecting" }));

      // Add local stream tracks to peer connection
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          peerConnection.addTrack(track, localStreamRef.current);
        });
      }

      // Handle incoming tracks
      peerConnection.ontrack = (event) => {
        console.log("Received remote track from:", userName);
        handleRemoteTrack(event, socketId, userName, userId);
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit("ice-candidate", {
            candidate: event.candidate,
            to: socketId,
            from: socketRef.current.id,
          });
        }
      };

      // Handle ICE connection state changes
      peerConnection.oniceconnectionstatechange = () => {
        handleIceConnectionStateChange(peerConnection, socketId, userName);
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        handleConnectionStateChange(peerConnection, socketId, userName);
      };

      // Handle negotiation needed
      peerConnection.onnegotiationneeded = async () => {
        if (isInitiator && peerConnection.signalingState === "stable") {
          await createAndSendOffer(peerConnection, socketId);
        }
      };

      // Handle signaling state changes
      peerConnection.onsignalingstatechange = () => {
        console.log(`Signaling state for ${userName}:`, peerConnection.signalingState);
      };

      // If initiator, create and send offer
      if (isInitiator) {
        await createAndSendOffer(peerConnection, socketId);
      }

      // Set connection timeout
      setTimeout(() => {
        if (peerConnection.iceConnectionState === "new" || 
            peerConnection.iceConnectionState === "checking") {
          console.warn("Peer connection timeout for:", userName);
          setError(`Failed to connect to ${userName}. Please check your network.`);
        }
      }, PEER_CONNECTION_TIMEOUT);

    } catch (err) {
      console.error("Error creating peer connection:", err);
      setError(`Failed to establish connection with ${userName}`);
      setConnectionStates((prev) => ({ ...prev, [socketId]: "failed" }));
    }
  };

  // Create and send offer with retry logic
  const createAndSendOffer = async (peerConnection, socketId, retryCount = 0) => {
    try {
      if (peerConnection.signalingState !== "stable") {
        console.log("Cannot create offer, signaling state:", peerConnection.signalingState);
        return;
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      await peerConnection.setLocalDescription(offer);

      socketRef.current.emit("offer", {
        offer,
        to: socketId,
        from: socketRef.current.id,
        userName: user.fullName,
        userId: user.id,
      });

      console.log("Offer sent to:", socketId);
    } catch (err) {
      console.error("Error creating/sending offer:", err);
      
      if (retryCount < 3) {
        console.log(`Retrying offer creation (attempt ${retryCount + 1})`);
        setTimeout(() => {
          createAndSendOffer(peerConnection, socketId, retryCount + 1);
        }, 1000 * (retryCount + 1));
      }
    }
  };

  // Handle remote track
  const handleRemoteTrack = (event, socketId, userName, userId) => {
    const [remoteStream] = event.streams;

    setParticipants((prev) => {
      // First, remove any existing entries for this userId (handles refresh scenario)
      const withoutUser = prev.filter((p) => p.userId !== userId);
      
      // Then add/update with the current socketId
      return [
        ...withoutUser,
        {
          socketId,
          userName,
          userId,
          stream: remoteStream,
          isAudioEnabled: true,
          isVideoEnabled: true,
        },
      ];
    });

    setConnectionStates((prev) => ({ ...prev, [socketId]: "connected" }));
  };

  // Handle ICE connection state changes
  const handleIceConnectionStateChange = (peerConnection, socketId, userName) => {
    const state = peerConnection.iceConnectionState;
    console.log(`ICE connection state for ${userName}:`, state);

    setConnectionStates((prev) => {
      const newState = { ...prev };
      
      switch (state) {
        case "connected":
        case "completed":
          newState[socketId] = "connected";
          break;
        case "disconnected":
          newState[socketId] = "disconnected";
          // Try to reconnect
          setTimeout(() => {
            if (peerConnection.iceConnectionState === "disconnected") {
              console.log("Attempting ICE restart for:", userName);
              peerConnection.restartIce();
            }
          }, 3000);
          break;
        case "failed":
          newState[socketId] = "failed";
          setError(`Connection failed with ${userName}. Attempting to reconnect...`);
          // Attempt to recreate connection
          setTimeout(() => {
            removeParticipant(socketId);
          }, 5000);
          break;
        case "closed":
          newState[socketId] = "closed";
          break;
      }
      
      return newState;
    });
  };

  // Handle connection state changes
  const handleConnectionStateChange = (peerConnection, socketId, userName) => {
    const state = peerConnection.connectionState;
    console.log(`Connection state for ${userName}:`, state);

    if (state === "failed") {
      console.log("Connection failed, attempting to reconnect:", userName);
      // Request renegotiation from remote peer
      socketRef.current.emit("request-renegotiation", {
        to: socketId,
        from: socketRef.current.id,
      });
    }
  };

  // Handle offer with proper state management
  const handleOffer = async (offer, from, userName, userId) => {
    try {
      let peerConnection = peerConnectionsRef.current[from];

      // Create peer connection if it doesn't exist
      if (!peerConnection) {
        await createPeerConnection(from, userName, userId, false);
        peerConnection = peerConnectionsRef.current[from];
      }

      if (!peerConnection) {
        console.error("Failed to create peer connection for offer");
        return;
      }

      // Handle rollback if necessary
      if (peerConnection.signalingState !== "stable") {
        console.log("Performing rollback before setting remote description");
        await peerConnection.setLocalDescription({ type: "rollback" });
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      // Process pending ICE candidates
      if (pendingCandidatesRef.current[from]) {
        for (const candidate of pendingCandidatesRef.current[from]) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error("Error adding pending ICE candidate:", err);
          }
        }
        pendingCandidatesRef.current[from] = [];
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socketRef.current.emit("answer", {
        answer,
        to: from,
        from: socketRef.current.id,
        userId: user.id,
      });

      console.log("Answer sent to:", from);
    } catch (err) {
      console.error("Error handling offer:", err);
      setError("Failed to process connection request. Please try again.");
    }
  };

  // Handle answer with state validation
  const handleAnswer = async (answer, from) => {
    try {
      const peerConnection = peerConnectionsRef.current[from];
      
      if (!peerConnection) {
        console.warn("No peer connection found for answer from:", from);
        return;
      }

      // Validate signaling state
      if (peerConnection.signalingState !== "have-local-offer") {
        console.warn(
          `Ignoring answer in signaling state: ${peerConnection.signalingState}`
        );
        return;
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

      // Process pending ICE candidates
      if (pendingCandidatesRef.current[from]) {
        for (const candidate of pendingCandidatesRef.current[from]) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error("Error adding pending ICE candidate:", err);
          }
        }
        pendingCandidatesRef.current[from] = [];
      }

      console.log("Answer processed from:", from);
    } catch (err) {
      console.error("Error handling answer:", err);
    }
  };

  // Handle ICE candidate with buffering
  const handleIceCandidate = async (candidate, from) => {
    try {
      const peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection) {
        console.warn("No peer connection for ICE candidate from:", from);
        return;
      }

      // Buffer candidates if remote description not set yet
      if (!peerConnection.remoteDescription) {
        console.log("Buffering ICE candidate, no remote description yet");
        if (!pendingCandidatesRef.current[from]) {
          pendingCandidatesRef.current[from] = [];
        }
        pendingCandidatesRef.current[from].push(candidate);
        return;
      }

      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Error handling ICE candidate:", err);
    }
  };

  // Remove participant with cleanup
  const removeParticipant = (socketId) => {
    console.log("Removing participant:", socketId);

    const peerConnection = peerConnectionsRef.current[socketId];
    if (peerConnection) {
      peerConnection.close();
      delete peerConnectionsRef.current[socketId];
    }

    // Clear pending candidates
    delete pendingCandidatesRef.current[socketId];

    // Remove from connection states
    setConnectionStates((prev) => {
      const newStates = { ...prev };
      delete newStates[socketId];
      return newStates;
    });

    // Remove from participants
    setParticipants((prev) => prev.filter((p) => p.socketId !== socketId));
  };

  // Toggle audio with proper track management
  const toggleAudio = async () => {
    if (!localStreamRef.current) return;

    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return;

    const newState = !isAudioEnabled;

    // Update track state
    audioTrack.enabled = newState;
    setIsAudioEnabled(newState);

    // Notify peers
    socketRef.current.emit("toggle-media", {
      roomId: meetingId,
      type: "audio",
      enabled: newState,
    });

    // If disabling and we want to stop transmission completely,
    // we would need to renegotiate (remove/add track)
    // For now, enabled=false stops audio data transmission
  };

  // Toggle video with proper track management
  const toggleVideo = async () => {
    if (!localStreamRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;

    const newState = !isVideoEnabled;

    if (newState) {
      // Re-enable video
      videoTrack.enabled = true;
      setIsVideoEnabled(true);
    } else {
      // Disable video
      videoTrack.enabled = false;
      setIsVideoEnabled(false);
    }

    // Notify peers
    socketRef.current.emit("toggle-media", {
      roomId: meetingId,
      type: "video",
      enabled: newState,
    });

    // Optional: For complete track removal/addition (requires renegotiation)
    // This would prevent any video data transmission
    /*
    if (!newState) {
      // Remove video track from all peer connections
      Object.values(peerConnectionsRef.current).forEach((pc) => {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender) {
          pc.removeTrack(videoSender);
        }
      });
    } else {
      // Add video track back to all peer connections
      Object.values(peerConnectionsRef.current).forEach((pc) => {
        pc.addTrack(videoTrack, localStreamRef.current);
      });
    }
    */
  };

  // Toggle recording with multi-participant support
  const toggleRecording = async () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  };

  // Start recording - captures all participants
  const startRecording = async () => {
    try {
      // Create canvas for mixing video streams
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d");

      // Create audio context for mixing audio
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const audioDestination = audioContext.createMediaStreamDestination();

      // Add local audio
      if (localStreamRef.current && isAudioEnabled) {
        const localAudioTrack = localStreamRef.current.getAudioTracks()[0];
        if (localAudioTrack) {
          const localSource = audioContext.createMediaStreamSource(
            new MediaStream([localAudioTrack])
          );
          localSource.connect(audioDestination);
        }
      }

      // Add remote audio from all participants
      participants.forEach((participant) => {
        if (participant.stream && participant.isAudioEnabled) {
          const audioTrack = participant.stream.getAudioTracks()[0];
          if (audioTrack) {
            const source = audioContext.createMediaStreamSource(
              new MediaStream([audioTrack])
            );
            source.connect(audioDestination);
          }
        }
      });

      // Render video frames to canvas
      const videoElements = [];

      // Add local video
      if (localVideoRef.current && isVideoEnabled) {
        videoElements.push(localVideoRef.current);
      }

      // Add remote videos
      participants.forEach((participant) => {
        if (participant.stream && participant.isVideoEnabled) {
          const video = document.createElement("video");
          video.srcObject = participant.stream;
          video.play();
          videoElements.push(video);
        }
      });

      // Calculate grid layout
      const drawVideoGrid = () => {
        if (!canvasRef.current) return;

        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const count = videoElements.length;
        if (count === 0) return;

        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        const cellWidth = canvas.width / cols;
        const cellHeight = canvas.height / rows;

        videoElements.forEach((video, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);
          const x = col * cellWidth;
          const y = row * cellHeight;

          ctx.drawImage(video, x, y, cellWidth, cellHeight);
        });

        if (isRecording) {
          requestAnimationFrame(drawVideoGrid);
        }
      };

      // Start rendering
      drawVideoGrid();

      // Create mixed stream
      const canvasStream = canvas.captureStream(30);
      const videoTrack = canvasStream.getVideoTracks()[0];
      const audioTrack = audioDestination.stream.getAudioTracks()[0];

      const mixedStream = new MediaStream([videoTrack, audioTrack]);
      mixedStreamRef.current = mixedStream;

      // Start MediaRecorder
      const options = { mimeType: "video/webm;codecs=vp9,opus" };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = "video/webm;codecs=vp8,opus";
      }
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = "video/webm";
      }

      mediaRecorderRef.current = new MediaRecorder(mixedStream, options);
      recordedChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      const recordingStartTime = Date.now();

      mediaRecorderRef.current.onstop = async () => {
        const recordingEndTime = Date.now();
        const duration = Math.floor((recordingEndTime - recordingStartTime) / 1000);

        const blob = new Blob(recordedChunksRef.current, {
          type: "video/webm",
        });

        // Get unique participant names
        const uniqueParticipants = Array.from(
          new Set([user.fullName, ...participants.map((p) => p.userName)])
        );

        // Create download link
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `meeting-${meetingId}-${Date.now()}.webm`;
        a.click();

        // Save recording metadata to backend
        try {
          const formData = new FormData();
          formData.append("recording", blob, a.download);
          formData.append("duration", duration);
          formData.append("participants", JSON.stringify(uniqueParticipants));
          formData.append("meetingId", meetingId);

          await api.post(`/api/meetings/${meetingId}/recording`, formData, {
            headers: {
              "Content-Type": "multipart/form-data",
            },
          });
        } catch (err) {
          console.error("Error saving recording:", err);
          setError("Recording saved locally but failed to upload to server");
        }

        // Cleanup
        URL.revokeObjectURL(url);
        if (canvasRef.current) {
          canvasRef.current = null;
        }
      };

      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);

      // Notify other participants
      socketRef.current.emit("recording-status", {
        roomId: meetingId,
        isRecording: true,
        userName: user.fullName,
      });
    } catch (err) {
      console.error("Error starting recording:", err);
      setError("Failed to start recording. Please try again.");
    }
  };

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);

      // Stop mixed stream
      if (mixedStreamRef.current) {
        mixedStreamRef.current.getTracks().forEach((track) => track.stop());
        mixedStreamRef.current = null;
      }

      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      // Notify other participants
      socketRef.current.emit("recording-status", {
        roomId: meetingId,
        isRecording: false,
        userName: user.fullName,
      });
    }
  };

  // Leave meeting with proper cleanup
  const leaveMeeting = () => {
    isLeavingRef.current = true;

    if (socketRef.current) {
      socketRef.current.emit("leave-room", {
        roomId: meetingId,
        userId: user.id,
      });
    }

    cleanup();
    navigate("/");
  };

  // Copy meeting ID
  const copyMeetingId = () => {
    const fullMeetingLink = `${window.location.origin}/meeting/${meetingId}`;
    navigator.clipboard.writeText(fullMeetingLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle page visibility change (user switches tabs)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log("Page hidden - maintaining connections");
      } else {
        console.log("Page visible - checking connections");
        // Could add connection health check here
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Handle beforeunload (user closes tab/browser)
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isRecording) {
        e.preventDefault();
        e.returnValue = "Recording is in progress. Are you sure you want to leave?";
        return e.returnValue;
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isRecording]);

  if (isInitializing) {
    return (
      <div className="meeting-room-loading">
        <div className="loading-spinner"></div>
        <p>Initializing meeting...</p>
      </div>
    );
  }

  return (
    <div className="meeting-room">
      {error && (
        <div className="meeting-error">
          {error}
          <button onClick={() => setError("")} className="error-close">
            ×
          </button>
        </div>
      )}

      <div className="meeting-header">
        <div className="meeting-info">
          <h2 className="meeting-title">Meeting Room</h2>
          <button onClick={copyMeetingId} className="meeting-id-btn">
            {copied ? <Check size={16} /> : <Copy size={16} />}
            <span>
              {copied ? "Link copied!" : `Meeting ID: ${meetingId.substring(0, 8)}...`}
            </span>
          </button>
        </div>
      </div>

      <div className="meeting-content">
        <div className="participants-grid">
          {/* Local video */}
          <div className="participant-card local">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={`participant-video ${!isVideoEnabled ? "hidden" : ""}`}
            />
            {!isVideoEnabled && (
              <div className="participant-placeholder">
                <div className="participant-avatar">
                  {user.fullName.charAt(0).toUpperCase()}
                </div>
              </div>
            )}
            <div className="participant-info">
              <span className="participant-name">You</span>
              {!isAudioEnabled && <MicOff size={14} className="muted-icon" />}
            </div>
          </div>

          {/* Remote participants */}
          {participants
            .filter((participant) => participant.stream)
            .map((participant) => (
              <ParticipantCard
                key={participant.socketId}
                participant={participant}
                connectionState={connectionStates[participant.socketId]}
              />
            ))}
        </div>
      </div>

      <div className="meeting-controls">
        <div className="controls-wrapper">
          <button
            onClick={toggleAudio}
            className={`control-btn ${!isAudioEnabled ? "muted" : ""}`}
            aria-label={isAudioEnabled ? "Mute" : "Unmute"}
            title={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
          >
            {isAudioEnabled ? <Mic size={24} /> : <MicOff size={24} />}
          </button>

          <button
            onClick={toggleVideo}
            className={`control-btn ${!isVideoEnabled ? "muted" : ""}`}
            aria-label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
            title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {isVideoEnabled ? <VideoIcon size={24} /> : <VideoOff size={24} />}
          </button>

          <button
            onClick={toggleRecording}
            className={`control-btn ${isRecording ? "recording" : ""}`}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            title={
              isRecording
                ? "Stop recording (includes all participants)"
                : "Start recording (includes all participants)"
            }
          >
            <Circle size={24} fill={isRecording ? "currentColor" : "none"} />
          </button>

          <button
            onClick={leaveMeeting}
            className="control-btn leave"
            aria-label="Leave meeting"
            title="Leave meeting"
          >
            <PhoneOff size={24} />
          </button>
        </div>
      </div>
    </div>
  );
};

// Participant card component with connection state
const ParticipantCard = ({ participant, connectionState }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      videoRef.current.srcObject = participant.stream;
    }
  }, [participant.stream]);

  return (
    <div className="participant-card">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`participant-video ${
          !participant.isVideoEnabled ? "hidden" : ""
        }`}
      />
      {!participant.isVideoEnabled && (
        <div className="participant-placeholder">
          <div className="participant-avatar">
            {participant.userName.charAt(0).toUpperCase()}
          </div>
        </div>
      )}
      <div className="participant-info">
        <span className="participant-name">{participant.userName}</span>
        {!participant.isAudioEnabled && (
          <MicOff size={14} className="muted-icon" />
        )}
      </div>
      {/* Connection state indicator (optional, can be styled) */}
      {connectionState && connectionState !== "connected" && (
        <div className="connection-indicator" title={connectionState}>
          {connectionState === "connecting" && "⏳"}
          {connectionState === "disconnected" && "🔄"}
          {connectionState === "failed" && "❌"}
        </div>
      )}
    </div>
  );
};

export default MeetingRoom;