import express from 'express';
import {
  createMeeting,
  getMeeting,
  endMeeting,
  saveRecording,
  getRecordings,
  deleteRecording,
  getMeetingRecording,
  updateRecordingStatus,
} from '../controllers/meetingController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/create', protect, createMeeting);
router.get('/recordings', protect, getRecordings);
router.get('/:meetingId', protect, getMeeting);
router.get('/:meetingId/recording', protect, getMeetingRecording);
router.put('/:meetingId/end', protect, endMeeting);
router.put('/:meetingId/recording-status', protect, updateRecordingStatus);
router.post('/:meetingId/recording', protect, saveRecording);
router.delete('/recordings/:recordingId', protect, deleteRecording);

export default router;