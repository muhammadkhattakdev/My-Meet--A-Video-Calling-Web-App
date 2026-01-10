import express from "express";
import {
  getMessages,
  createMessage,
  editMessage,
  deleteMessage,
} from "../controllers/messageController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.get("/:meetingId", protect, getMessages);
router.post("/:meetingId", protect, createMessage);
router.put("/:messageId", protect, editMessage);
router.delete("/:messageId", protect, deleteMessage);

export default router;
