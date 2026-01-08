import express from 'express';
import { register, login, getProfile, verifyToken} from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/profile', protect, getProfile);
router.get('/verify', protect, verifyToken);

export default router;