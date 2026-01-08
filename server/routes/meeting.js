import express from 'express';
import {
  createMeeting,
  getMeeting,
  endMeeting,
  saveRecording,
  getRecordings,
  deleteRecording,
} from '../controllers/meetingController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/create', protect, createMeeting);
router.get('/recordings', protect, getRecordings);
router.get('/:meetingId', protect, getMeeting);
router.put('/:meetingId/end', protect, endMeeting);
router.post('/:meetingId/recording', protect, saveRecording);
router.delete('/recordings/:recordingId', protect, deleteRecording);

export default router;