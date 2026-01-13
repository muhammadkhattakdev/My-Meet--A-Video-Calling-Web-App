import mongoose from 'mongoose';

const transcriptionSchema = new mongoose.Schema(
  {
    meetingId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    entries: [
      {
        userName: {
          type: String,
          required: true,
        },
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        text: {
          type: String,
          required: true,
          trim: true,
        },
        timestamp: {
          type: Date,
          required: true,
          default: Date.now,
        },
        secondsIntoMeeting: {
          type: Number,
          required: true,
        },
        confidence: {
          type: Number,
          min: 0,
          max: 1,
          default: 1,
        },
      },
    ],
    startedAt: {
      type: Date,
      required: true,
    },
    endedAt: {
      type: Date,
    },
    totalDuration: {
      type: Number, // in seconds
    },
    participantCount: {
      type: Number,
      default: 0,
    },
    fullText: {
      type: String,
      default: '',
    },
    metadata: {
      language: {
        type: String,
        default: 'en-US',
      },
      averageConfidence: {
        type: Number,
        default: 1,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
transcriptionSchema.index({ meetingId: 1, 'entries.timestamp': 1 });

const Transcription = mongoose.model('Transcription', transcriptionSchema);

export default Transcription;