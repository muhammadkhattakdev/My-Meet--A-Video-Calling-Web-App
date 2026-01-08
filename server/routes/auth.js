const express = "express";
const { register, login, getProfile, verifyToken } =
  "../controllers/authController.js";
const { protect } = "../middleware/auth.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.get("/profile", protect, getProfile);
router.get("/verify", protect, verifyToken);

export default router;
