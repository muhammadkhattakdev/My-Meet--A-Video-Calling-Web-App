import express from 'express';
import {
  saveTranscription,
  getTranscription,
  deleteTranscription,
  exportTranscription,
} from '../controllers/transcriptionController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/:meetingId', protect, saveTranscription);
router.get('/:meetingId', protect, getTranscription);
router.get('/:meetingId/export', protect, exportTranscription);
router.delete('/:meetingId', protect, deleteTranscription);

export default router;