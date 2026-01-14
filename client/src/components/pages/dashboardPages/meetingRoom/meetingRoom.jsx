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
  Users,
  UserPlus,
  UserCheck,
  Clock,
  Shield,
  Loader2,
  X,
  CheckCircle,
  XCircle,
  AlertCircle,
  MessageCircle,
  FileText,
} from "lucide-react";
import { io } from "socket.io-client";
import "./style.css";
import api from "../../../request";
import { useApp } from "../../../../context/context";
import RoomMessaging from "../../../dashboardComponents/roomMessaging/roomMessaging";
import TranscriptionWidget from "../../../dashboardComponents/transcriptionWidget/transcriptionWidget";

// ============================================================================
// CONSTANTS
// ============================================================================
const MAX_RECONNECTION_ATTEMPTS = 5;
const RECONNECTION_DELAY = 2000;
const ICE_GATHERING_TIMEOUT = 10000;
const PEER_CONNECTION_TIMEOUT = 30000;
const WAITING_ROOM_POLL_INTERVAL = 30000;

// Transcription constants
const INTERIM_UPDATE_THROTTLE = 100; // ms - throttle interim updates
const FINAL_RESULT_DEBOUNCE = 300; // ms - debounce final results

// ============================================================================
// ADMISSION STATUS ENUM
// ============================================================================
const AdmissionStatus = {
  INITIALIZING: "initializing",
  REQUESTING: "requesting",
  WAITING: "waiting",
  APPROVED: "approved",
  DENIED: "denied",
  EXPIRED: "expired",
  ERROR: "error",
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================
const MeetingRoom = () => {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const { user } = useApp();

  // -------------------------------------------------------------------------
  // REFS
  // -------------------------------------------------------------------------
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
  const admissionRequestSentRef = useRef(false);

  // -------------------------------------------------------------------------
  // STATE - Media Controls
  // -------------------------------------------------------------------------
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isRecording, setIsRecording] = useState(false);

  // -------------------------------------------------------------------------
  // STATE - Participants
  // -------------------------------------------------------------------------
  const [participants, setParticipants] = useState([]);
  const [connectionStates, setConnectionStates] = useState({});
  const [speakingParticipants, setSpeakingParticipants] = useState(new Set());
  const [isLocalUserSpeaking, setIsLocalUserSpeaking] = useState(false);

  // -------------------------------------------------------------------------
  // STATE - UI
  // -------------------------------------------------------------------------
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [isInitializing, setIsInitializing] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [isTranscriptionOpen, setIsTranscriptionOpen] = useState(false);

  // -------------------------------------------------------------------------
  // STATE - Transcription (IMPROVED)
  // -------------------------------------------------------------------------
  const [transcriptionEntries, setTranscriptionEntries] = useState([]); // React state for UI updates
  const transcriptionEntriesRef = useRef([]); // Ref for stable access
  const recognitionRef = useRef(null);
  const meetingStartTimeRef = useRef(null);
  
  // NEW: Track interim transcriptions per user
  const interimTranscriptionsRef = useRef(new Map()); // Map<userId, {text, lastUpdate}>
  const finalResultTimeoutRef = useRef(null);
  const interimUpdateTimeoutRef = useRef(null);
  const isTranscriptionActiveRef = useRef(false);

  // -------------------------------------------------------------------------
  // STATE - Admission Control
  // -------------------------------------------------------------------------
  const [admissionStatus, setAdmissionStatus] = useState(AdmissionStatus.INITIALIZING);
  const [isHost, setIsHost] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [showWaitingRoom, setShowWaitingRoom] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [waitingMessage, setWaitingMessage] = useState("Connecting...");

  // -------------------------------------------------------------------------
  // ICE SERVERS CONFIGURATION
  // -------------------------------------------------------------------------
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ],
    iceCandidatePoolSize: 10,
  };

  // =========================================================================
  // TRANSCRIPTION - ADD ENTRY HELPER
  // =========================================================================
  const addTranscriptionEntry = useCallback((entry) => {
    console.log('🔍 [addTranscriptionEntry] Before add:', {
      currentCount: transcriptionEntriesRef.current.length,
      newEntry: {
        userId: entry.userId,
        userName: entry.userName,
        text: entry.text
      }
    });

    // Deep copy entry to prevent any mutation
    const entryCopy = {
      ...entry,
      userId: entry.userId,      // Ensure not mutated
      userName: entry.userName,  // Ensure not mutated
    };

    // Add to ref (stable reference)
    transcriptionEntriesRef.current = [...transcriptionEntriesRef.current, entryCopy];
    
    console.log('🔍 [addTranscriptionEntry] After add:', {
      newCount: transcriptionEntriesRef.current.length,
      allEntries: transcriptionEntriesRef.current.map(e => ({
        userId: e.userId,
        userName: e.userName,
        text: e.text.substring(0, 20)
      }))
    });

    // Update state (triggers re-render)
    setTranscriptionEntries(prev => [...prev, entryCopy]);
    
    console.log(`📝 Added transcription entry: [${entryCopy.secondsIntoMeeting}s] ${entryCopy.userName}: ${entryCopy.text}`);
  }, []);

  // =========================================================================
  // TRANSCRIPTION - UPDATE INTERIM HELPER
  // =========================================================================
  const updateInterimTranscription = useCallback((userId, userName, interimText) => {
    if (!interimText || !interimText.trim()) {
      // Clear interim for this user
      interimTranscriptionsRef.current.delete(userId);
      setTranscriptionEntries(prev => [...transcriptionEntriesRef.current]); // Force re-render without interim
      return;
    }

    // Update interim map
    interimTranscriptionsRef.current.set(userId, {
      userId,
      userName,
      text: interimText.trim(),
      lastUpdate: Date.now(),
      isInterim: true,
    });

    // Throttled state update
    if (!interimUpdateTimeoutRef.current) {
      interimUpdateTimeoutRef.current = setTimeout(() => {
        setTranscriptionEntries(prev => [...transcriptionEntriesRef.current]);
        interimUpdateTimeoutRef.current = null;
      }, INTERIM_UPDATE_THROTTLE);
    }
  }, []);

  // =========================================================================
  // TRANSCRIPTION - CLEAR INTERIM HELPER
  // =========================================================================
  const clearInterimTranscription = useCallback((userId) => {
    interimTranscriptionsRef.current.delete(userId);
    setTranscriptionEntries(prev => [...transcriptionEntriesRef.current]);
  }, []);

  // =========================================================================
  // CLEANUP FUNCTION
  // =========================================================================
  const cleanup = useCallback(() => {
    isLeavingRef.current = true;

    // Save transcription before leaving (host only)
    if (isHost && transcriptionEntriesRef.current.length > 0) {
      (async () => {
        try {
          console.log('💾 Saving transcription...');
          
          await api.post(`/api/transcriptions/${meetingId}`, {
            entries: transcriptionEntriesRef.current,
            startedAt: new Date(meetingStartTimeRef.current),
          });

          console.log('✅ Transcription saved successfully');
        } catch (error) {
          console.error('❌ Failed to save transcription:', error);
        }
      })();
    }

    // Stop speech recognition
    isTranscriptionActiveRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      } catch (err) {
        console.warn('Error stopping recognition in cleanup:', err);
      }
    }

    // Clear timeouts
    if (finalResultTimeoutRef.current) {
      clearTimeout(finalResultTimeoutRef.current);
    }
    if (interimUpdateTimeoutRef.current) {
      clearTimeout(interimUpdateTimeoutRef.current);
    }

    if (isRecording && mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error("Error stopping recording:", e);
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      localStreamRef.current = null;
    }

    Object.values(peerConnectionsRef.current).forEach((pc) => {
      if (pc && pc.close) {
        pc.close();
      }
    });
    peerConnectionsRef.current = {};
    pendingCandidatesRef.current = {};

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mixedStreamRef.current) {
      mixedStreamRef.current.getTracks().forEach((track) => track.stop());
      mixedStreamRef.current = null;
    }
  }, [isRecording, isHost, meetingId]);

  // =========================================================================
  // MEDIA ERROR HANDLER
  // =========================================================================
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

  // =========================================================================
  // INITIALIZE MEDIA & SOCKET
  // =========================================================================
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

  // =========================================================================
  // AUDIO LEVEL DETECTION FOR LOCAL USER
  // =========================================================================
  useEffect(() => {
    if (!localStreamRef.current || !isAudioEnabled) {
      setIsLocalUserSpeaking(false);
      return;
    }

    let audioContext = null;
    let rafId = null;

    const timeoutId = setTimeout(() => {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(localStreamRef.current);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        analyser.smoothingTimeConstant = 0.8;
        analyser.fftSize = 1024;
        microphone.connect(analyser);

        const detectAudio = () => {
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          
          const isSpeaking = average > 20;
          setIsLocalUserSpeaking(isSpeaking);

          rafId = requestAnimationFrame(detectAudio);
        };

        detectAudio();
      } catch (err) {
        console.warn('Failed to initialize audio detection:', err);
      }
    }, 1000);

    return () => {
      clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      if (audioContext) {
        try {
          audioContext.close();
        } catch (err) {
          console.warn('Error closing audio context:', err);
        }
      }
    };
  }, [isAudioEnabled]);

  // =========================================================================
  // AUDIO LEVEL DETECTION FOR REMOTE PARTICIPANTS
  // =========================================================================
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const audioContexts = new Map();
      const rafIds = new Map();

      participants.forEach((participant) => {
        if (!participant.stream || !participant.isAudioEnabled) {
          setSpeakingParticipants((prev) => {
            const newSet = new Set(prev);
            newSet.delete(participant.socketId);
            return newSet;
          });
          return;
        }

        try {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const analyser = audioContext.createAnalyser();
          const source = audioContext.createMediaStreamSource(participant.stream);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          analyser.smoothingTimeConstant = 0.8;
          analyser.fftSize = 1024;
          source.connect(analyser);

          audioContexts.set(participant.socketId, audioContext);

          const detectAudio = () => {
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
            
            const isSpeaking = average > 20;
            
            setSpeakingParticipants((prev) => {
              const newSet = new Set(prev);
              if (isSpeaking) {
                newSet.add(participant.socketId);
              } else {
                newSet.delete(participant.socketId);
              }
              return newSet;
            });

            rafIds.set(participant.socketId, requestAnimationFrame(detectAudio));
          };

          detectAudio();
        } catch (err) {
          console.warn(`Failed to create audio detection for ${participant.userName}:`, err);
        }
      });

      return () => {
        rafIds.forEach((rafId) => cancelAnimationFrame(rafId));
        audioContexts.forEach((context) => {
          try {
            context.close();
          } catch (err) {
            console.warn('Error closing audio context:', err);
          }
        });
      };
    }, 1500);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [participants.length]);

  // =========================================================================
  // TRANSCRIPTION - SET MEETING START TIME
  // =========================================================================
  useEffect(() => {
    if (admissionStatus === AdmissionStatus.APPROVED && !meetingStartTimeRef.current) {
      meetingStartTimeRef.current = Date.now();
      console.log('📅 Meeting start time recorded:', meetingStartTimeRef.current);
      
      if (isHost && socketRef.current) {
        socketRef.current.emit('set-meeting-start-time', {
          roomId: meetingId,
          startTime: meetingStartTimeRef.current
        });
      }
    }
  }, [admissionStatus, isHost, meetingId]);

  // =========================================================================
  // TRANSCRIPTION - AUTO-START SPEECH RECOGNITION (IMPROVED)
  // =========================================================================
  useEffect(() => {
    // Only start if approved, have local stream, socket connected, and not already running
    if (
      admissionStatus !== AdmissionStatus.APPROVED ||
      !localStreamRef.current ||
      !socketRef.current ||
      recognitionRef.current ||
      !meetingStartTimeRef.current
    ) {
      return;
    }

    // Delay transcription start
    const timeoutId = setTimeout(() => {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      
      if (!SpeechRecognition) {
        console.warn('⚠️ Speech recognition not supported in this browser');
        return;
      }

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true; // CRITICAL: Enable interim results
        recognition.lang = navigator.language || 'en-US';
        recognition.maxAlternatives = 1;

        let currentInterimText = '';
        let lastFinalResultTime = 0;

        // Handle transcription results (IMPROVED)
        recognition.onresult = (event) => {
          try {
            const resultIndex = event.resultIndex;
            const result = event.results[resultIndex];
            
            if (!result) return;

            const transcript = result[0].transcript;
            const confidence = result[0].confidence || 1;
            const isFinal = result.isFinal;

            console.log(`🎤 [${isFinal ? 'FINAL' : 'INTERIM'}] "${transcript}" (confidence: ${confidence.toFixed(2)})`);

            if (isFinal) {
              // FINAL RESULT - Send to socket and add to entries
              
              // Clear any interim for this user
              clearInterimTranscription(user.id);
              
              // Debounce final results to avoid duplicates
              const now = Date.now();
              if (now - lastFinalResultTime < FINAL_RESULT_DEBOUNCE) {
                console.log('⏭️  Skipping duplicate final result (debounced)');
                return;
              }
              lastFinalResultTime = now;

              const secondsIntoMeeting = Math.floor((now - meetingStartTimeRef.current) / 1000);

              const entry = {
                id: `${now}-${Math.random().toString(36).substr(2, 9)}`,
                userId: user.id,
                userName: user.fullName,
                text: transcript.trim(),
                timestamp: now,
                secondsIntoMeeting,
                confidence,
                isFinal: true,
              };

              // Add to local entries
              addTranscriptionEntry(entry);

              // Broadcast to all participants via socket
              if (socketRef.current && socketRef.current.connected) {
                socketRef.current.emit('transcription-entry', {
                  roomId: meetingId,
                  ...entry,
                });
              }

              currentInterimText = '';
            } else {
              // INTERIM RESULT - Update UI in real-time
              currentInterimText = transcript.trim();
              
              // Update interim display for local user
              updateInterimTranscription(user.id, user.fullName, currentInterimText);

              // Broadcast interim to other participants
              if (socketRef.current && socketRef.current.connected) {
                socketRef.current.emit('transcription-interim', {
                  roomId: meetingId,
                  userId: user.id,
                  userName: user.fullName,
                  text: currentInterimText,
                  timestamp: Date.now(),
                });
              }
            }
          } catch (err) {
            console.error('Error processing transcription result:', err);
          }
        };

        recognition.onerror = (event) => {
          console.error('Speech recognition error:', event.error);
          
          // Don't restart on certain errors
          if (event.error === 'aborted' || event.error === 'not-allowed') {
            isTranscriptionActiveRef.current = false;
            return;
          }
          
          // Auto-restart on recoverable errors
          if (event.error === 'no-speech' || event.error === 'audio-capture' || event.error === 'network') {
            setTimeout(() => {
              if (isTranscriptionActiveRef.current && recognitionRef.current) {
                try {
                  console.log('🔄 Restarting recognition after error:', event.error);
                  recognitionRef.current.start();
                } catch (err) {
                  console.warn('Failed to restart recognition:', err);
                }
              }
            }, 1000);
          }
        };

        recognition.onend = () => {
          console.log('🛑 Recognition ended');
          
          // Auto-restart if still in meeting
          if (isTranscriptionActiveRef.current && admissionStatus === AdmissionStatus.APPROVED) {
            setTimeout(() => {
              if (recognitionRef.current && isTranscriptionActiveRef.current) {
                try {
                  console.log('🔄 Restarting recognition after end');
                  recognition.start();
                } catch (err) {
                  console.warn('Failed to restart recognition on end:', err);
                }
              }
            }, 500);
          }
        };

        recognition.onstart = () => {
          console.log('▶️  Recognition started');
        };

        // Start recognition
        try {
          recognition.start();
          recognitionRef.current = recognition;
          isTranscriptionActiveRef.current = true;
          console.log('🎤 Auto-transcription started successfully');
        } catch (err) {
          console.error('Failed to start transcription:', err);
        }
      } catch (err) {
        console.error('Failed to initialize speech recognition:', err);
      }
    }, 2000);

    // Cleanup
    return () => {
      clearTimeout(timeoutId);
      isTranscriptionActiveRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
          recognitionRef.current = null;
        } catch (err) {
          console.warn('Error stopping recognition:', err);
        }
      }
    };
  }, [admissionStatus, user.id, user.fullName, meetingId, addTranscriptionEntry, updateInterimTranscription, clearInterimTranscription]);

  // =========================================================================
  // TRANSCRIPTION - RECEIVE UPDATES FROM OTHERS (IMPROVED)
  // =========================================================================
  useEffect(() => {
    if (!socketRef.current) return;

    // Handle FINAL transcription entries from other users
    const handleTranscriptionEntry = (entry) => {
      try {
        console.log('🔍 [DEBUG] Received transcription-update:', {
          entryUserId: entry.userId,
          entryUserName: entry.userName,
          currentUserId: user.id,
          currentUserName: user.fullName,
          text: entry.text,
          entryId: entry.id
        });

        // NOTE: We no longer need to check if it's our own entry
        // because backend uses socket.to() which excludes the sender

        // Clear any interim for this user
        clearInterimTranscription(entry.userId);

        // Add to entries
        console.log('➕ [DEBUG] Adding entry to transcriptions:', {
          id: entry.id,
          userId: entry.userId,
          userName: entry.userName,
          text: entry.text
        });
        addTranscriptionEntry(entry);

        console.log(`📝 Received final transcription from ${entry.userName}`);
      } catch (err) {
        console.error('Error handling transcription entry:', err);
      }
    };

    // Handle INTERIM transcription updates from other users
    const handleTranscriptionInterim = (data) => {
      try {
        // Don't process our own interim updates
        if (data.userId === user.id) {
          return;
        }

        // Update interim display for this user
        updateInterimTranscription(data.userId, data.userName, data.text);

        console.log(`💬 Received interim from ${data.userName}: "${data.text}"`);
      } catch (err) {
        console.error('Error handling interim transcription:', err);
      }
    };

    // Handle transcription history (for reconnection & late joiners)
    const handleTranscriptionHistory = ({ entries, count }) => {
      try {
        console.log(`📜 Received transcription history: ${count} entries`);
        
        if (entries && entries.length > 0) {
          // Don't clear existing entries if we already have some loaded
          // This prevents race conditions
          const currentEntries = transcriptionEntriesRef.current;
          
          // Deep copy entries to prevent mutation
          const historicalEntries = entries.map(e => ({
            ...e,
            userId: e.userId,      // Ensure these are preserved
            userName: e.userName,  // Ensure these are preserved
          }));
          
          console.log('🔍 [handleTranscriptionHistory] Historical entries:', 
            historicalEntries.map(e => ({ userId: e.userId, userName: e.userName, text: e.text.substring(0, 20) }))
          );
          
          // Only add entries that don't exist
          const newEntries = [];
          historicalEntries.forEach(entry => {
            const exists = currentEntries.some(e => e.id === entry.id);
            if (!exists) {
              newEntries.push(entry);
            }
          });
          
          if (newEntries.length > 0) {
            // Add new entries to existing ones
            transcriptionEntriesRef.current = [...currentEntries, ...newEntries];
            setTranscriptionEntries([...transcriptionEntriesRef.current]);
            
            console.log(`✅ Added ${newEntries.length} new historical transcriptions`);
          } else {
            console.log('ℹ️  No new historical entries to add');
          }
        }
      } catch (err) {
        console.error('Error handling transcription history:', err);
      }
    };

    // Handle meeting start time (for late joiners)
    const handleMeetingStartTime = ({ startTime }) => {
      if (!meetingStartTimeRef.current) {
        meetingStartTimeRef.current = startTime;
        console.log('📅 Received meeting start time:', startTime);
      }
    };

    socketRef.current.on('transcription-update', handleTranscriptionEntry);
    socketRef.current.on('transcription-interim', handleTranscriptionInterim);
    socketRef.current.on('transcription-history', handleTranscriptionHistory);
    socketRef.current.on('meeting-start-time', handleMeetingStartTime);

    // Request meeting start time if we don't have it
    if (!meetingStartTimeRef.current && admissionStatus === AdmissionStatus.APPROVED) {
      socketRef.current.emit('request-meeting-start-time', { roomId: meetingId });
    }
    
    // Request transcription history (for reconnection & late joiners)
    if (admissionStatus === AdmissionStatus.APPROVED) {
      socketRef.current.emit('request-transcription-history', { roomId: meetingId });
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.off('transcription-update', handleTranscriptionEntry);
        socketRef.current.off('transcription-interim', handleTranscriptionInterim);
        socketRef.current.off('transcription-history', handleTranscriptionHistory);
        socketRef.current.off('meeting-start-time', handleMeetingStartTime);
      }
    };
  }, [user.id, admissionStatus, meetingId, addTranscriptionEntry, updateInterimTranscription, clearInterimTranscription]);

  // =========================================================================
  // SOCKET INITIALIZATION WITH ADMISSION CONTROL
  // =========================================================================
  const initializeSocket = () => {
    if (socketRef.current && socketRef.current.connected) {
      console.log("Socket already connected, skipping initialization");
      return;
    }
    
    if (socketRef.current) {
      console.log("Disconnecting existing socket before creating new one");
      socketRef.current.disconnect();
    }
    
    const socketUrl = import.meta.env.VITE_API_URL || "http://localhost:5000";
    console.log("Initializing socket connection to:", socketUrl);

    socketRef.current = io(socketUrl, {
      reconnection: true,
      reconnectionAttempts: MAX_RECONNECTION_ATTEMPTS,
      reconnectionDelay: RECONNECTION_DELAY,
      timeout: 10000,
      forceNew: false,
      multiplex: true,
    });

    // Socket Connection Events
    socketRef.current.on("connect", handleSocketConnect);
    socketRef.current.on("disconnect", handleSocketDisconnect);
    socketRef.current.on("reconnect", handleSocketReconnect);
    socketRef.current.on("reconnect_failed", handleSocketReconnectFailed);

    // Admission Control Events
    socketRef.current.on("join-approved", handleJoinApproved);
    socketRef.current.on("join-denied", handleJoinDenied);
    socketRef.current.on("waiting-for-approval", handleWaitingForApproval);
    socketRef.current.on("join-request", handleJoinRequest);
    socketRef.current.on("join-request-processed", handleJoinRequestProcessed);
    socketRef.current.on("join-request-expired", handleJoinRequestExpired);
    socketRef.current.on("pending-join-requests", handlePendingJoinRequests);
    socketRef.current.on("meeting-ended", handleMeetingEnded);
    socketRef.current.on("host-left", handleHostLeft);

    // WebRTC Signaling Events
    socketRef.current.on("existing-participants", handleExistingParticipants);
    socketRef.current.on("user-joined", handleUserJoined);
    socketRef.current.on("offer", handleOfferReceived);
    socketRef.current.on("answer", handleAnswerReceived);
    socketRef.current.on("ice-candidate", handleIceCandidateReceived);
    socketRef.current.on("user-left", handleUserLeft);
    socketRef.current.on("user-disconnected", handleUserDisconnected);
    socketRef.current.on("user-media-toggle", handleUserMediaToggle);
    socketRef.current.on("renegotiation-needed", handleRenegotiationNeeded);

    // Error Handler
    socketRef.current.on("error", (data) => {
      console.error("Socket error:", data.message);
      setError(data.message);
    });
  };

  // =========================================================================
  // SOCKET EVENT HANDLERS - Connection
  // =========================================================================
  const handleSocketConnect = () => {
    console.log("Socket connected:", socketRef.current.id);
    reconnectionAttemptsRef.current = 0;
    setError("");

    if (admissionStatus === AdmissionStatus.APPROVED) {
      console.log("Already approved, rejoining room with new socket");
      socketRef.current.emit("request-join-room", {
        roomId: meetingId,
        oduserId: user.id,
        userName: user.fullName,
        isRejoin: true,
      });
    } else if (!admissionRequestSentRef.current) {
      setAdmissionStatus(AdmissionStatus.REQUESTING);
      admissionRequestSentRef.current = true;

      socketRef.current.emit("request-join-room", {
        roomId: meetingId,
        oduserId: user.id,
        userName: user.fullName,
        isRejoin: false,
      });
    } else if (admissionStatus === AdmissionStatus.WAITING) {
      socketRef.current.emit("update-waiting-socket", {
        roomId: meetingId,
        oduserId: user.id,
      });
    }
  };

  const handleSocketDisconnect = (reason) => {
    console.log("Socket disconnected:", reason);

    if (isLeavingRef.current) return;

    if (admissionStatus === AdmissionStatus.APPROVED) {
      setError("Connection lost. Attempting to reconnect...");

      setConnectionStates((prev) => {
        const newStates = { ...prev };
        Object.keys(newStates).forEach((id) => {
          newStates[id] = "disconnected";
        });
        return newStates;
      });
    }
  };

  const handleSocketReconnect = (attemptNumber) => {
    console.log("Socket reconnected after", attemptNumber, "attempts");
    setError("");

    if (admissionStatus === AdmissionStatus.APPROVED) {
      socketRef.current.emit("request-join-room", {
        roomId: meetingId,
        oduserId: user.id,
        userName: user.fullName,
        isRejoin: true,
      });
    } else if (admissionStatus === AdmissionStatus.WAITING) {
      socketRef.current.emit("update-waiting-socket", {
        roomId: meetingId,
        oduserId: user.id,
      });
    }
  };

  const handleSocketReconnectFailed = () => {
    console.error("Socket reconnection failed");
    setError("Connection lost. Please refresh the page to rejoin the meeting.");
    setAdmissionStatus(AdmissionStatus.ERROR);
  };

  // =========================================================================
  // SOCKET EVENT HANDLERS - Admission Control
  // =========================================================================
  const handleJoinApproved = ({ roomId, isHost: userIsHost, pendingRequests: pending, message }) => {
    console.log("Join approved:", { roomId, isHost: userIsHost, message });

    setAdmissionStatus(AdmissionStatus.APPROVED);
    setIsHost(userIsHost);
    setWaitingMessage("");

    if (userIsHost && pending && pending.length > 0) {
      setPendingRequests(pending);
      setShowWaitingRoom(true);
    }

    socketRef.current.emit("join-room", {
      roomId: meetingId,
      oduserId: user.id,
      userName: user.fullName,
      mediaState: {
        audio: isAudioEnabled,
        video: isVideoEnabled,
      },
    });
  };

  const handleJoinDenied = ({ reason, permanent }) => {
    console.log("Join denied:", reason);
    setAdmissionStatus(AdmissionStatus.DENIED);
    setDenyReason(reason || "Your request to join was denied by the host.");
  };

  const handleWaitingForApproval = ({ message, position, isDuplicate }) => {
    console.log("Waiting for approval:", message);
    setAdmissionStatus(AdmissionStatus.WAITING);
    setWaitingMessage(message || "Waiting for the host to admit you...");
  };

  const handleJoinRequest = ({ oduserId, userName, requesterId, requestedAt }) => {
    console.log("New join request from:", userName);

    setPendingRequests((prev) => {
      const exists = prev.some((r) => r.oduserId === oduserId);
      if (exists) {
        return prev.map((r) =>
          r.oduserId === oduserId ? { ...r, socketId: requesterId, requestedAt } : r
        );
      }
      return [...prev, { oduserId, userName, socketId: requesterId, requestedAt }];
    });

    setShowWaitingRoom(true);
  };

  const handleJoinRequestProcessed = ({ oduserId, userName, action }) => {
    console.log(`Join request ${action} for:`, userName);
    setPendingRequests((prev) => prev.filter((r) => r.oduserId !== oduserId));
  };

  const handleJoinRequestExpired = ({ message }) => {
    console.log("Join request expired");
    setAdmissionStatus(AdmissionStatus.EXPIRED);
    setWaitingMessage(message);
  };

  const handlePendingJoinRequests = (requests) => {
    console.log("Received pending requests:", requests.length);
    setPendingRequests(requests);
    if (requests.length > 0) {
      setShowWaitingRoom(true);
    }
  };

  const handleMeetingEnded = ({ message, endedBy }) => {
    console.log("Meeting ended by:", endedBy);
    setError(message);
    cleanup();
    setTimeout(() => {
      navigate("/");
    }, 3000);
  };

  const handleHostLeft = ({ message, hostName }) => {
    console.log("Host left:", hostName);
    setError(`${hostName} (host) has left the meeting.`);
  };

  // =========================================================================
  // ADMISSION CONTROL ACTIONS
  // =========================================================================
  const approveJoinRequest = (oduserId) => {
    console.log("Approving:", oduserId);
    socketRef.current.emit("approve-join-request", {
      roomId: meetingId,
      oduserId,
      approverUserId: user.id,
    });
  };

  const denyJoinRequest = (oduserId, reason = "") => {
    console.log("Denying:", oduserId);
    socketRef.current.emit("deny-join-request", {
      roomId: meetingId,
      oduserId,
      reason,
      approverUserId: user.id,
    });
  };

  const admitAllWaiting = () => {
    console.log("Admitting all waiting users");
    socketRef.current.emit("admit-all-waiting", {
      roomId: meetingId,
      approverUserId: user.id,
    });
    setPendingRequests([]);
  };

  // =========================================================================
  // SOCKET EVENT HANDLERS - WebRTC Signaling
  // =========================================================================
  const handleExistingParticipants = async (existingParticipants) => {
    console.log("Existing participants:", existingParticipants);

    for (const participant of existingParticipants) {
      if (participant.oduserId === user.id) continue;

      await createPeerConnection(
        participant.socketId,
        participant.userName,
        participant.oduserId,
        true
      );
    }
  };

  const handleUserJoined = async ({ socketId, userName, oduserId, mediaState }) => {
    console.log("User joined:", userName, socketId);

    if (oduserId === user.id) return;

    Object.entries(peerConnectionsRef.current).forEach(([oldSocketId, pc]) => {
      const existingParticipant = participants.find((p) => p.socketId === oldSocketId);
      if (
        existingParticipant &&
        existingParticipant.oduserId === oduserId &&
        oldSocketId !== socketId
      ) {
        console.log("Cleaning up old connection for refreshed user:", userName);
        removeParticipant(oldSocketId);
      }
    });

    await createPeerConnection(socketId, userName, oduserId, false);
  };

  const handleOfferReceived = async ({ offer, from, userName, oduserId }) => {
    console.log("Received offer from:", userName);
    await handleOffer(offer, from, userName, oduserId);
  };

  const handleAnswerReceived = async ({ answer, from }) => {
    console.log("Received answer from:", from);
    await handleAnswer(answer, from);
  };

  const handleIceCandidateReceived = async ({ candidate, from }) => {
    await handleIceCandidate(candidate, from);
  };

  const handleUserLeft = ({ socketId, userName, oduserId, wasHost }) => {
    console.log("User left:", userName);
    removeParticipant(socketId);

    // Clear interim transcriptions for this user
    if (oduserId) {
      clearInterimTranscription(oduserId);
    }

    if (wasHost) {
      setError(`Host ${userName} has left the meeting.`);
    }
  };

  const handleUserDisconnected = ({ socketId, oduserId }) => {
    console.log("User disconnected (old socket):", socketId);
    removeParticipant(socketId);

    // Clear interim transcriptions for this user
    if (oduserId) {
      clearInterimTranscription(oduserId);
    }

    setParticipants((prev) =>
      prev.filter((p) => !(p.oduserId === oduserId && p.socketId !== socketId))
    );
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

  const handleRenegotiationNeeded = async ({ from, userName, oduserId }) => {
    console.log("Renegotiation needed for:", userName);
    const pc = peerConnectionsRef.current[from];
    if (pc && pc.signalingState === "stable") {
      await createAndSendOffer(pc, from);
    }
  };

  // =========================================================================
  // WEBRTC - Peer Connection Management
  // =========================================================================
  const createPeerConnection = async (socketId, userName, oduserId, isInitiator) => {
    if (oduserId === user.id) {
      console.log("Skipping self-connection");
      return;
    }

    try {
      if (peerConnectionsRef.current[socketId]) {
        console.log("Closing existing peer connection for:", userName);
        peerConnectionsRef.current[socketId].close();
        delete peerConnectionsRef.current[socketId];
      }

      const peerConnection = new RTCPeerConnection(iceServers);
      peerConnectionsRef.current[socketId] = peerConnection;

      pendingCandidatesRef.current[socketId] = [];

      setConnectionStates((prev) => ({ ...prev, [socketId]: "connecting" }));

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          peerConnection.addTrack(track, localStreamRef.current);
        });
      }

      peerConnection.ontrack = (event) => {
        console.log("Received remote track from:", userName);
        handleRemoteTrack(event, socketId, userName, oduserId);
      };

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current.emit("ice-candidate", {
            candidate: event.candidate,
            to: socketId,
            from: socketRef.current.id,
          });
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        handleIceConnectionStateChange(peerConnection, socketId, userName);
      };

      peerConnection.onconnectionstatechange = () => {
        handleConnectionStateChange(peerConnection, socketId, userName);
      };

      peerConnection.onnegotiationneeded = async () => {
        if (isInitiator && peerConnection.signalingState === "stable") {
          await createAndSendOffer(peerConnection, socketId);
        }
      };

      peerConnection.onsignalingstatechange = () => {
        console.log(`Signaling state for ${userName}:`, peerConnection.signalingState);
      };

      if (isInitiator) {
        await createAndSendOffer(peerConnection, socketId);
      }

      setTimeout(() => {
        if (
          peerConnection.iceConnectionState === "new" ||
          peerConnection.iceConnectionState === "checking"
        ) {
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
        oduserId: user.id,
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

  const handleRemoteTrack = (event, socketId, userName, oduserId) => {
    const [remoteStream] = event.streams;

    setParticipants((prev) => {
      const withoutUser = prev.filter((p) => p.oduserId !== oduserId);

      return [
        ...withoutUser,
        {
          socketId,
          userName,
          oduserId,
          stream: remoteStream,
          isAudioEnabled: true,
          isVideoEnabled: true,
        },
      ];
    });

    setConnectionStates((prev) => ({ ...prev, [socketId]: "connected" }));
  };

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

  const handleConnectionStateChange = (peerConnection, socketId, userName) => {
    const state = peerConnection.connectionState;
    console.log(`Connection state for ${userName}:`, state);

    if (state === "failed") {
      console.log("Connection failed, attempting to reconnect:", userName);
      socketRef.current.emit("request-renegotiation", {
        to: socketId,
        from: socketRef.current.id,
      });
    }
  };

  const handleOffer = async (offer, from, userName, oduserId) => {
    try {
      let peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection) {
        await createPeerConnection(from, userName, oduserId, false);
        peerConnection = peerConnectionsRef.current[from];
      }

      if (!peerConnection) {
        console.error("Failed to create peer connection for offer");
        return;
      }

      if (peerConnection.signalingState !== "stable") {
        console.log("Performing rollback before setting remote description");
        await peerConnection.setLocalDescription({ type: "rollback" });
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

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
        oduserId: user.id,
      });

      console.log("Answer sent to:", from);
    } catch (err) {
      console.error("Error handling offer:", err);
      setError("Failed to process connection request. Please try again.");
    }
  };

  const handleAnswer = async (answer, from) => {
    try {
      const peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection) {
        console.warn("No peer connection found for answer from:", from);
        return;
      }

      if (peerConnection.signalingState !== "have-local-offer") {
        console.warn(`Ignoring answer in signaling state: ${peerConnection.signalingState}`);
        return;
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

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

  const handleIceCandidate = async (candidate, from) => {
    try {
      const peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection) {
        console.warn("No peer connection for ICE candidate from:", from);
        return;
      }

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

  const removeParticipant = (socketId) => {
    console.log("Removing participant:", socketId);

    const peerConnection = peerConnectionsRef.current[socketId];
    if (peerConnection) {
      peerConnection.close();
      delete peerConnectionsRef.current[socketId];
    }

    delete pendingCandidatesRef.current[socketId];

    setConnectionStates((prev) => {
      const newStates = { ...prev };
      delete newStates[socketId];
      return newStates;
    });

    setParticipants((prev) => prev.filter((p) => p.socketId !== socketId));
  };

  // =========================================================================
  // MEDIA CONTROLS
  // =========================================================================
  const toggleAudio = async () => {
    if (!localStreamRef.current) return;

    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return;

    const newState = !isAudioEnabled;

    audioTrack.enabled = newState;
    
    Object.values(peerConnectionsRef.current).forEach((pc) => {
      if (pc && pc.getSenders) {
        const audioSender = pc.getSenders().find(sender => 
          sender.track && sender.track.kind === 'audio'
        );
        if (audioSender && audioSender.track) {
          audioSender.track.enabled = newState;
        }
      }
    });
    
    setIsAudioEnabled(newState);
    
    console.log(`Audio ${newState ? 'enabled' : 'disabled'}`);

    // CRITICAL: Stop/start speech recognition when microphone is toggled
    if (recognitionRef.current) {
      if (newState) {
        // Microphone enabled - restart speech recognition
        try {
          recognitionRef.current.start();
          console.log('🎤 Speech recognition restarted after mic enable');
        } catch (err) {
          console.warn('Error restarting speech recognition:', err);
        }
      } else {
        // Microphone disabled - stop speech recognition
        try {
          recognitionRef.current.stop();
          console.log('🔇 Speech recognition stopped after mic disable');
        } catch (err) {
          console.warn('Error stopping speech recognition:', err);
        }
      }
    }

    socketRef.current?.emit("toggle-media", {
      roomId: meetingId,
      type: "audio",
      enabled: newState,
    });
  };

  const toggleVideo = async () => {
    if (!localStreamRef.current) return;

    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;

    const newState = !isVideoEnabled;

    videoTrack.enabled = newState;
    
    Object.values(peerConnectionsRef.current).forEach((pc) => {
      if (pc && pc.getSenders) {
        const videoSender = pc.getSenders().find(sender => 
          sender.track && sender.track.kind === 'video'
        );
        if (videoSender && videoSender.track) {
          videoSender.track.enabled = newState;
        }
      }
    });
    
    setIsVideoEnabled(newState);
    
    console.log(`Video ${newState ? 'enabled' : 'disabled'}`);

    socketRef.current?.emit("toggle-media", {
      roomId: meetingId,
      type: "video",
      enabled: newState,
    });
  };

  // =========================================================================
  // RECORDING
  // =========================================================================
  const toggleRecording = async () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  };

  const startRecording = async () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d");

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const audioDestination = audioContext.createMediaStreamDestination();

      if (localStreamRef.current && isAudioEnabled) {
        const localAudioTrack = localStreamRef.current.getAudioTracks()[0];
        if (localAudioTrack) {
          const localSource = audioContext.createMediaStreamSource(
            new MediaStream([localAudioTrack])
          );
          localSource.connect(audioDestination);
        }
      }

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

      const videoElements = [];

      if (localVideoRef.current && isVideoEnabled) {
        videoElements.push(localVideoRef.current);
      }

      participants.forEach((participant) => {
        if (participant.stream && participant.isVideoEnabled) {
          const video = document.createElement("video");
          video.srcObject = participant.stream;
          video.play();
          videoElements.push(video);
        }
      });

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

      drawVideoGrid();

      const canvasStream = canvas.captureStream(30);
      const videoTrack = canvasStream.getVideoTracks()[0];
      const audioTrack = audioDestination.stream.getAudioTracks()[0];

      const mixedStream = new MediaStream([videoTrack, audioTrack]);
      mixedStreamRef.current = mixedStream;

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

        const uniqueParticipants = Array.from(
          new Set([user.fullName, ...participants.map((p) => p.userName)])
        );

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `meeting-${meetingId}-${Date.now()}.webm`;
        a.click();

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

        URL.revokeObjectURL(url);
        if (canvasRef.current) {
          canvasRef.current = null;
        }
      };

      mediaRecorderRef.current.start(1000);
      setIsRecording(true);

      socketRef.current?.emit("recording-status", {
        roomId: meetingId,
        isRecording: true,
        userName: user.fullName,
      });
    } catch (err) {
      console.error("Error starting recording:", err);
      setError("Failed to start recording. Please try again.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);

      if (mixedStreamRef.current) {
        mixedStreamRef.current.getTracks().forEach((track) => track.stop());
        mixedStreamRef.current = null;
      }

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      socketRef.current?.emit("recording-status", {
        roomId: meetingId,
        isRecording: false,
        userName: user.fullName,
      });
    }
  };

  // =========================================================================
  // MEETING ACTIONS
  // =========================================================================
  const leaveMeeting = () => {
    isLeavingRef.current = true;

    if (socketRef.current) {
      socketRef.current.emit("leave-room", {
        roomId: meetingId,
        oduserId: user.id,
      });
    }

    cleanup();
    navigate("/");
  };

  const copyMeetingId = () => {
    const fullMeetingLink = `${window.location.origin}/room/${meetingId}`;
    navigator.clipboard.writeText(fullMeetingLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // =========================================================================
  // PAGE VISIBILITY & BEFOREUNLOAD HANDLERS
  // =========================================================================
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log("Page hidden - maintaining connections");
      } else {
        console.log("Page visible - checking connections");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

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

  // =========================================================================
  // RENDER - Loading State
  // =========================================================================
  if (isInitializing) {
    return (
      <div className="meeting-room-loading">
        <div className="loading-spinner"></div>
        <p>Initializing meeting...</p>
      </div>
    );
  }

  // =========================================================================
  // RENDER - Waiting Room
  // =========================================================================
  if (
    admissionStatus === AdmissionStatus.WAITING ||
    admissionStatus === AdmissionStatus.REQUESTING
  ) {
    return (
      <WaitingScreen
        status={admissionStatus}
        message={waitingMessage}
        meetingId={meetingId}
        userName={user.fullName}
        onCancel={() => {
          cleanup();
          navigate("/");
        }}
        localVideoRef={localVideoRef}
        isVideoEnabled={isVideoEnabled}
        isAudioEnabled={isAudioEnabled}
        onToggleVideo={toggleVideo}
        onToggleAudio={toggleAudio}
      />
    );
  }

  // =========================================================================
  // RENDER - Denied Screen
  // =========================================================================
  if (admissionStatus === AdmissionStatus.DENIED) {
    return <DeniedScreen reason={denyReason} onGoBack={() => navigate("/")} />;
  }

  // =========================================================================
  // RENDER - Expired Screen
  // =========================================================================
  if (admissionStatus === AdmissionStatus.EXPIRED) {
    return (
      <ExpiredScreen
        message={waitingMessage}
        onRetry={() => {
          admissionRequestSentRef.current = false;
          setAdmissionStatus(AdmissionStatus.INITIALIZING);
          if (socketRef.current?.connected) {
            socketRef.current.emit("request-join-room", {
              roomId: meetingId,
              oduserId: user.id,
              userName: user.fullName,
              isRejoin: false,
            });
          }
        }}
        onGoBack={() => navigate("/")}
      />
    );
  }

  // =========================================================================
  // RENDER - Error Screen
  // =========================================================================
  if (admissionStatus === AdmissionStatus.ERROR) {
    return (
      <ErrorScreen
        error={error}
        onRetry={() => window.location.reload()}
        onGoBack={() => navigate("/")}
      />
    );
  }

  // =========================================================================
  // RENDER - Main Meeting Room
  // =========================================================================
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
          <div className="meeting-info-left">
            <h2 className="meeting-title">Meeting Room</h2>
            <button onClick={copyMeetingId} className="meeting-id-btn">
              {copied ? <Check size={16} /> : <Copy size={16} />}
              <span>{copied ? "Link copied!" : `ID: ${meetingId.substring(0, 8)}...`}</span>
            </button>
          </div>

          {isHost && (
            <div className="host-controls">
              <button
                onClick={() => setShowWaitingRoom(!showWaitingRoom)}
                className={`waiting-room-toggle ${pendingRequests.length > 0 ? "has-requests" : ""}`}
              >
                <Users size={20} />
                {pendingRequests.length > 0 && (
                  <span className="request-badge">{pendingRequests.length}</span>
                )}
                <span>Waiting Room</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {isHost && showWaitingRoom && (
        <WaitingRoomPanel
          pendingRequests={pendingRequests}
          onApprove={approveJoinRequest}
          onDeny={denyJoinRequest}
          onAdmitAll={admitAllWaiting}
          onClose={() => setShowWaitingRoom(false)}
        />
      )}

      <div className="meeting-content">
        <div className="participants-grid">
          <div className="participant-card local">
            {isLocalUserSpeaking && <SpeakingIndicator />}
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
              <span className="participant-name">
                You {isHost && <Shield size={12} className="host-badge" />}
              </span>
              {!isAudioEnabled && <MicOff size={14} className="muted-icon" />}
            </div>
          </div>

          {participants
            .filter((participant) => participant.stream)
            .map((participant) => (
              <ParticipantCard
                key={participant.socketId}
                participant={participant}
                connectionState={connectionStates[participant.socketId]}
                isSpeaking={speakingParticipants.has(participant.socketId)}
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
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`control-btn ${isChatOpen ? "active" : ""}`}
            aria-label={isChatOpen ? "Close chat" : "Open chat"}
            title={isChatOpen ? "Close chat" : "Open chat"}
          >
            <MessageCircle size={24} />
            {!isChatOpen && chatUnreadCount > 0 && (
              <span className="control-badge">{chatUnreadCount > 99 ? '99+' : chatUnreadCount}</span>
            )}
          </button>

          <button
            onClick={() => setIsTranscriptionOpen(!isTranscriptionOpen)}
            className={`control-btn ${isTranscriptionOpen ? "active" : ""}`}
            aria-label={isTranscriptionOpen ? "Close transcription" : "View transcription"}
            title={isTranscriptionOpen ? "Close transcription" : "View live transcription"}
          >
            <FileText size={24} />
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

      {/* Room Messaging Component */}
      <RoomMessaging
        meetingId={meetingId}
        userId={user.id}
        userName={user.fullName}
        socketRef={socketRef}
        isOpen={isChatOpen}
        setIsOpen={setIsChatOpen}
        onUnreadCountChange={setChatUnreadCount}
      />

      {/* Transcription Widget Component - PASS BOTH FINAL + INTERIM */}
      <TranscriptionWidget
        isOpen={isTranscriptionOpen}
        setIsOpen={setIsTranscriptionOpen}
        entries={transcriptionEntries} // React state
        interimTranscriptions={interimTranscriptionsRef.current} // Map of interim transcriptions
        meetingId={meetingId}
        userId={user.id}
      />
    </div>
  );
};

// ============================================================================
// WAITING SCREEN COMPONENT
// ============================================================================
const WaitingScreen = ({
  status,
  message,
  meetingId,
  userName,
  onCancel,
  localVideoRef,
  isVideoEnabled,
  isAudioEnabled,
  onToggleVideo,
  onToggleAudio,
}) => {
  return (
    <div className="waiting-screen">
      <div className="waiting-container">
        <div className="waiting-preview">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`preview-video ${!isVideoEnabled ? "hidden" : ""}`}
          />
          {!isVideoEnabled && (
            <div className="preview-placeholder">
              <div className="preview-avatar">{userName.charAt(0).toUpperCase()}</div>
            </div>
          )}
          <div className="preview-controls">
            <button
              onClick={onToggleAudio}
              className={`preview-btn ${!isAudioEnabled ? "off" : ""}`}
            >
              {isAudioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
            </button>
            <button
              onClick={onToggleVideo}
              className={`preview-btn ${!isVideoEnabled ? "off" : ""}`}
            >
              {isVideoEnabled ? <VideoIcon size={20} /> : <VideoOff size={20} />}
            </button>
          </div>
        </div>

        <div className="waiting-info">
          <div className="waiting-icon">
            {status === AdmissionStatus.REQUESTING ? (
              <Loader2 size={48} className="spin" />
            ) : (
              <Clock size={48} />
            )}
          </div>
          <h2 className="waiting-title">
            {status === AdmissionStatus.REQUESTING
              ? "Connecting..."
              : "Waiting to be admitted"}
          </h2>
          <p className="waiting-message">{message}</p>
          <p className="waiting-meeting-id">Meeting ID: {meetingId.substring(0, 8)}...</p>

          <div className="waiting-tips">
            <p>💡 The host will let you in soon</p>
            <p>📹 Make sure your camera and mic are working</p>
          </div>

          <button onClick={onCancel} className="waiting-cancel-btn">
            Cancel and go back
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// DENIED SCREEN COMPONENT
// ============================================================================
const DeniedScreen = ({ reason, onGoBack }) => {
  return (
    <div className="denied-screen">
      <div className="denied-container">
        <div className="denied-icon">
          <XCircle size={64} />
        </div>
        <h2 className="denied-title">Access Denied</h2>
        <p className="denied-reason">{reason}</p>
        <button onClick={onGoBack} className="denied-btn">
          Go to Homepage
        </button>
      </div>
    </div>
  );
};

// ============================================================================
// EXPIRED SCREEN COMPONENT
// ============================================================================
const ExpiredScreen = ({ message, onRetry, onGoBack }) => {
  return (
    <div className="expired-screen">
      <div className="expired-container">
        <div className="expired-icon">
          <AlertCircle size={64} />
        </div>
        <h2 className="expired-title">Request Expired</h2>
        <p className="expired-message">{message}</p>
        <div className="expired-actions">
          <button onClick={onRetry} className="retry-btn">
            Try Again
          </button>
          <button onClick={onGoBack} className="back-btn">
            Go to Homepage
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// ERROR SCREEN COMPONENT
// ============================================================================
const ErrorScreen = ({ error, onRetry, onGoBack }) => {
  return (
    <div className="error-screen">
      <div className="error-container">
        <div className="error-icon">
          <XCircle size={64} />
        </div>
        <h2 className="error-title">Something went wrong</h2>
        <p className="error-message">{error}</p>
        <div className="error-actions">
          <button onClick={onRetry} className="retry-btn">
            Refresh Page
          </button>
          <button onClick={onGoBack} className="back-btn">
            Go to Homepage
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// WAITING ROOM PANEL COMPONENT
// ============================================================================
const WaitingRoomPanel = ({ pendingRequests, onApprove, onDeny, onAdmitAll, onClose }) => {
  const formatWaitTime = (requestedAt) => {
    const seconds = Math.floor((Date.now() - requestedAt) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  };

  return (
    <div className="waiting-room-panel">
      <div className="waiting-room-header">
        <h3>
          <Users size={20} />
          Waiting Room ({pendingRequests.length})
        </h3>
        <button onClick={onClose} className="close-panel-btn">
          <X size={20} />
        </button>
      </div>

      {pendingRequests.length === 0 ? (
        <div className="waiting-room-empty">
          <UserPlus size={32} />
          <p>No one is waiting to join</p>
        </div>
      ) : (
        <>
          <div className="waiting-room-actions">
            <button onClick={onAdmitAll} className="admit-all-btn">
              <UserCheck size={16} />
              Admit All
            </button>
          </div>

          <div className="waiting-room-list">
            {pendingRequests.map((request) => (
              <div key={request.oduserId} className="waiting-user">
                <div className="waiting-user-avatar">
                  {request.userName.charAt(0).toUpperCase()}
                </div>
                <div className="waiting-user-info">
                  <span className="waiting-user-name">{request.userName}</span>
                  <span className="waiting-user-time">
                    Waiting {formatWaitTime(request.requestedAt)}
                  </span>
                </div>
                <div className="waiting-user-actions">
                  <button
                    onClick={() => onApprove(request.oduserId)}
                    className="approve-btn"
                    title="Admit"
                  >
                    <CheckCircle size={20} />
                  </button>
                  <button
                    onClick={() => onDeny(request.oduserId)}
                    className="deny-btn"
                    title="Deny"
                  >
                    <XCircle size={20} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ============================================================================
// SPEAKING INDICATOR COMPONENT
// ============================================================================
const SpeakingIndicator = () => {
  return (
    <div className="speaking-indicator">
      <div className="bar bar-1"></div>
      <div className="bar bar-2"></div>
      <div className="bar bar-3"></div>
    </div>
  );
};

// ============================================================================
// PARTICIPANT CARD COMPONENT
// ============================================================================
const ParticipantCard = ({ participant, connectionState, isSpeaking }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      videoRef.current.srcObject = participant.stream;
    }
  }, [participant.stream]);

  return (
    <div className="participant-card">
      {isSpeaking && <SpeakingIndicator />}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`participant-video ${!participant.isVideoEnabled ? "hidden" : ""}`}
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
        {!participant.isAudioEnabled && <MicOff size={14} className="muted-icon" />}
      </div>
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