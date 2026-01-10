import Message from "../models/Message.js";

// @desc    Get all messages for a meeting
// @route   GET /api/messages/:meetingId
// @access  Private
export const getMessages = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { limit = 100, before } = req.query;

    const query = {
      meetingId,
      isDeleted: false,
    };

    // Pagination support - get messages before a certain timestamp
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    // Reverse to get chronological order (oldest first)
    messages.reverse();

    res.status(200).json({
      success: true,
      data: {
        messages,
        count: messages.length,
      },
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({
      success: false,
      message: "Server error fetching messages",
      error: error.message,
    });
  }
};

// @desc    Create a new message
// @route   POST /api/messages/:meetingId
// @access  Private
export const createMessage = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message content is required",
      });
    }

    const message = await Message.create({
      meetingId,
      userId: req.user._id,
      userName: req.user.fullName,
      content: content.trim(),
      timestamp: new Date(),
    });

    res.status(201).json({
      success: true,
      message: "Message sent successfully",
      data: {
        message,
      },
    });
  } catch (error) {
    console.error("Create message error:", error);
    res.status(500).json({
      success: false,
      message: "Server error creating message",
      error: error.message,
    });
  }
};

// @desc    Edit a message
// @route   PUT /api/messages/:messageId
// @access  Private
export const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message content is required",
      });
    }

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    // Only the message author can edit
    if (message.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own messages",
      });
    }

    message.content = content.trim();
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    res.status(200).json({
      success: true,
      message: "Message updated successfully",
      data: {
        message,
      },
    });
  } catch (error) {
    console.error("Edit message error:", error);
    res.status(500).json({
      success: false,
      message: "Server error editing message",
      error: error.message,
    });
  }
};

// @desc    Delete a message
// @route   DELETE /api/messages/:messageId
// @access  Private
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    // Only the message author can delete
    if (message.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages",
      });
    }

    message.isDeleted = true;
    message.deletedAt = new Date();
    await message.save();

    res.status(200).json({
      success: true,
      message: "Message deleted successfully",
    });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({
      success: false,
      message: "Server error deleting message",
      error: error.message,
    });
  }
};
