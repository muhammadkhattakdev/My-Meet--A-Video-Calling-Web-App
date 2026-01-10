import { v4 as uuidv4 } from 'uuid';
import Meeting from '../models/Meeting.js';
import User from '../models/User.js';
import path from 'path';
import fs from 'fs';

// @desc    Create a new meeting
// @route   POST /api/meetings/create
// @access  Private
export const createMeeting = async (req, res) => {
  try {
    const { title } = req.body;
    const meetingId = uuidv4();

    const meeting = await Meeting.create({
      meetingId,
      hostId: req.user._id,
      hostName: req.user.fullName,
      title: title || 'Untitled Meeting',
      participants: [
        {
          userId: req.user._id,
          name: req.user.fullName,
        },
      ],
    });

    res.status(201).json({
      success: true,
      message: 'Meeting created successfully',
      data: {
        meeting: {
          id: meeting._id,
          meetingId: meeting.meetingId,
          title: meeting.title,
          hostName: meeting.hostName,
          startedAt: meeting.startedAt,
        },
      },
    });
  } catch (error) {
    console.error('Create meeting error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating meeting',
      error: error.message,
    });
  }
};

// @desc    Get meeting details
// @route   GET /api/meetings/:meetingId
// @access  Private
export const getMeeting = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const meeting = await Meeting.findOne({ meetingId })
      .populate('hostId', 'fullName email')
      .populate('participants.userId', 'fullName email');

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        meeting: {
          id: meeting._id,
          meetingId: meeting.meetingId,
          title: meeting.title,
          hostName: meeting.hostName,
          hostId: meeting.hostId,
          participants: meeting.participants,
          status: meeting.status,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt,
          isRecording: meeting.isRecording,
          recording: meeting.recording,
        },
      },
    });
  } catch (error) {
    console.error('Get meeting error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching meeting',
      error: error.message,
    });
  }
};

// @desc    End a meeting
// @route   PUT /api/meetings/:meetingId/end
// @access  Private
export const endMeeting = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const meeting = await Meeting.findOne({ meetingId });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found',
      });
    }

    // Only host can end the meeting
    if (meeting.hostId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can end the meeting',
      });
    }

    meeting.status = 'ended';
    meeting.endedAt = new Date();
    await meeting.save();

    res.status(200).json({
      success: true,
      message: 'Meeting ended successfully',
      data: {
        meeting: {
          meetingId: meeting.meetingId,
          status: meeting.status,
          endedAt: meeting.endedAt,
        },
      },
    });
  } catch (error) {
    console.error('End meeting error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error ending meeting',
      error: error.message,
    });
  }
};

// @desc    Save recording metadata (file already uploaded)
// @route   POST /api/meetings/:meetingId/recording
// @access  Private
export const saveRecording = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { recordingUrl, duration, fileSize, participants } = req.body;

    const meeting = await Meeting.findOne({ meetingId });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found',
      });
    }

    // Only participants can save recordings
    const isParticipant = meeting.participants.some(
      p => p.userId.toString() === req.user._id.toString()
    );
    
    if (!isParticipant && meeting.hostId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only participants can save recordings',
      });
    }

    // Update meeting with recording info
    meeting.recording = {
      recordingUrl,
      duration: duration || 0,
      fileSize: fileSize || 0,
      recordedBy: req.user._id,
      recordedByName: req.user.fullName,
      participants: participants || [],
      recordedAt: new Date(),
    };
    meeting.isRecording = false;
    await meeting.save();

    // Add recording to user's profile
    const user = await User.findById(req.user._id);
    user.recordings.push({
      meetingId,
      meetingTitle: meeting.title,
      recordingUrl,
      duration: duration || 0,
      fileSize: fileSize || 0,
      participants: participants || [],
      recordedAt: new Date(),
    });
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Recording saved successfully',
      data: {
        recording: meeting.recording,
      },
    });
  } catch (error) {
    console.error('Save recording error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error saving recording',
      error: error.message,
    });
  }
};

// @desc    Get user's recordings
// @route   GET /api/meetings/recordings
// @access  Private
export const getRecordings = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('recordings');

    res.status(200).json({
      success: true,
      data: {
        recordings: user.recordings.sort((a, b) => 
          new Date(b.recordedAt) - new Date(a.recordedAt)
        ),
      },
    });
  } catch (error) {
    console.error('Get recordings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching recordings',
      error: error.message,
    });
  }
};

// @desc    Delete a recording
// @route   DELETE /api/meetings/recordings/:recordingId
// @access  Private
export const deleteRecording = async (req, res) => {
  try {
    const { recordingId } = req.params;

    const user = await User.findById(req.user._id);
    const recordingIndex = user.recordings.findIndex(
      (rec) => rec._id.toString() === recordingId
    );

    if (recordingIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found',
      });
    }

    const recording = user.recordings[recordingIndex];
    
    // Delete file from filesystem if it exists
    if (recording.recordingUrl && recording.recordingUrl.startsWith('/uploads')) {
      const filePath = path.join(process.cwd(), recording.recordingUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    user.recordings.splice(recordingIndex, 1);
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Recording deleted successfully',
    });
  } catch (error) {
    console.error('Delete recording error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting recording',
      error: error.message,
    });
  }
};

// @desc    Get meeting recording
// @route   GET /api/meetings/:meetingId/recording
// @access  Private
export const getMeetingRecording = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const meeting = await Meeting.findOne({ meetingId });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found',
      });
    }

    if (!meeting.recording) {
      return res.status(404).json({
        success: false,
        message: 'No recording found for this meeting',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        recording: meeting.recording,
      },
    });
  } catch (error) {
    console.error('Get meeting recording error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching recording',
      error: error.message,
    });
  }
};

// @desc    Update recording status
// @route   PUT /api/meetings/:meetingId/recording-status
// @access  Private
export const updateRecordingStatus = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { isRecording } = req.body;

    const meeting = await Meeting.findOne({ meetingId });

    if (!meeting) {
      return res.status(404).json({
        success: false,
        message: 'Meeting not found',
      });
    }

    meeting.isRecording = isRecording;
    await meeting.save();

    res.status(200).json({
      success: true,
      message: 'Recording status updated',
      data: {
        isRecording: meeting.isRecording,
      },
    });
  } catch (error) {
    console.error('Update recording status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating recording status',
      error: error.message,
    });
  }
};