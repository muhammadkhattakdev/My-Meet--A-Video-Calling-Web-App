import Transcription from '../models/Transcription.js';

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

// Helper: Generate formatted full text
const generateFullText = (entries) => {
  return entries
    .map((e) => `[${formatMeetingTime(e.secondsIntoMeeting)}] ${e.userName}: ${e.text}`)
    .join('\n');
};

// @desc    Save complete transcription at meeting end
// @route   POST /api/transcriptions/:meetingId
// @access  Private
export const saveTranscription = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { entries, startedAt } = req.body;

    if (!entries || entries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No transcription entries provided',
      });
    }

    // Check if transcription already exists
    const existingTranscription = await Transcription.findOne({ meetingId });
    if (existingTranscription) {
      return res.status(400).json({
        success: false,
        message: 'Transcription already exists for this meeting',
      });
    }

    // Calculate metadata
    const endedAt = new Date();
    const totalDuration = Math.floor((endedAt - new Date(startedAt)) / 1000);
    const uniqueParticipants = new Set(entries.map((e) => e.userId.toString()));
    const averageConfidence =
      entries.reduce((sum, e) => sum + (e.confidence || 1), 0) / entries.length;

    // Generate formatted text
    const fullText = generateFullText(entries);

    const transcription = await Transcription.create({
      meetingId,
      entries,
      startedAt,
      endedAt,
      totalDuration,
      participantCount: uniqueParticipants.size,
      fullText,
      metadata: {
        language: entries[0]?.language || 'en-US',
        averageConfidence,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Transcription saved successfully',
      data: {
        transcription: {
          meetingId: transcription.meetingId,
          entryCount: transcription.entries.length,
          totalDuration: transcription.totalDuration,
          participantCount: transcription.participantCount,
        },
      },
    });
  } catch (error) {
    console.error('Save transcription error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error saving transcription',
      error: error.message,
    });
  }
};

// @desc    Get transcription for a meeting
// @route   GET /api/transcriptions/:meetingId
// @access  Private
export const getTranscription = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const transcription = await Transcription.findOne({ meetingId })
      .populate('entries.userId', 'fullName email')
      .lean();

    if (!transcription) {
      return res.status(404).json({
        success: false,
        message: 'Transcription not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        transcription,
      },
    });
  } catch (error) {
    console.error('Get transcription error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching transcription',
      error: error.message,
    });
  }
};

// @desc    Delete transcription
// @route   DELETE /api/transcriptions/:meetingId
// @access  Private
export const deleteTranscription = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const transcription = await Transcription.findOne({ meetingId });

    if (!transcription) {
      return res.status(404).json({
        success: false,
        message: 'Transcription not found',
      });
    }

    await transcription.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Transcription deleted successfully',
    });
  } catch (error) {
    console.error('Delete transcription error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting transcription',
      error: error.message,
    });
  }
};

// @desc    Export transcription as formatted text
// @route   GET /api/transcriptions/:meetingId/export
// @access  Private
export const exportTranscription = async (req, res) => {
  try {
    const { meetingId } = req.params;

    const transcription = await Transcription.findOne({ meetingId }).lean();

    if (!transcription) {
      return res.status(404).json({
        success: false,
        message: 'Transcription not found',
      });
    }

    const exportText = `Meeting Transcript
Meeting ID: ${transcription.meetingId}
Duration: ${formatMeetingTime(transcription.totalDuration)}
Date: ${new Date(transcription.startedAt).toLocaleDateString()}
Participants: ${transcription.participantCount}

${transcription.fullText}

---
Generated by MyMeet
`;

    res.status(200).json({
      success: true,
      data: {
        text: exportText,
        fileName: `transcript-${transcription.meetingId}-${Date.now()}.txt`,
      },
    });
  } catch (error) {
    console.error('Export transcription error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error exporting transcription',
      error: error.message,
    });
  }
};