const express = require('express');
const router = express.Router();

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { pool } = require('../config/db');

// ========================================
// PICTURE, VIDEO AND VOICE NOTE UPLOAD CONFIGURATION
// ========================================

const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '..', 'public', 'uploads'));
    },

    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const uniqueName = crypto.randomBytes(16).toString('hex');

        cb(null, `${uniqueName}${extension}`);
    }
});

const allowedMediaTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'audio/webm',
    'audio/mp4',
    'audio/ogg',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/3gpp'
]);

const uploadMedia = multer({
    storage: uploadStorage,

    limits: {
        fileSize: 50 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const mimeType = (file.mimetype || '')
            .split(';')[0]
            .trim()
            .toLowerCase();

        console.log('NEXA upload MIME type:', file.mimetype);
        console.log('NEXA normalized MIME type:', mimeType);

        if (allowedMediaTypes.has(mimeType)) {
            return cb(null, true);
        }

        return cb(new Error('Unsupported media type: ' + mimeType));
    }
});

// ========================================
// SEARCH USERS
// GET /api/chat/users?q=nelson
// ========================================
router.get('/users', async (req, res) => {
    try {
        const search = String(req.query.q || '').trim();
        const currentUserId = Number(req.session.userId);

        if (search.length < 2) {
            return res.json({
                success: true,
                users: []
            });
        }

        const term = `%${search}%`;

        const [users] = await pool.execute(
            `SELECT
                id,
                full_name,
                username,
                profile_picture,
                bio
             FROM users
             WHERE is_verified = 1
               AND is_active = 1
               AND id <> ?
               AND (
                   username LIKE ?
                   OR full_name LIKE ?
               )
             ORDER BY username ASC
             LIMIT 20`,
            [currentUserId, term, term]
        );

        return res.json({
            success: true,
            users
        });

    } catch (error) {
        console.error('User search error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not search for users.'
        });
    }
});


// ========================================
// GET CONVERSATIONS
// GET /api/chat/conversations
// ========================================
router.get('/conversations', async (req, res) => {
    try {
        const userId = Number(req.session.userId);

        const [conversations] = await pool.execute(
            `SELECT
                c.id AS conversation_id,
                c.updated_at,
                u.id AS other_user_id,
                u.full_name,
                u.username,
                u.profile_picture,

                (
                    SELECT m.message_text
                    FROM messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message,

                (
                    SELECT m.created_at
                    FROM messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message_at,

                (
                    SELECT COUNT(*)
                    FROM messages unread
                    WHERE unread.conversation_id = c.id
                      AND unread.sender_id = u.id
                      AND unread.read_at IS NULL
                ) AS unread_count

             FROM conversations c

             INNER JOIN conversation_members mine
                ON mine.conversation_id = c.id
               AND mine.user_id = ?

             INNER JOIN conversation_members other
                ON other.conversation_id = c.id
               AND other.user_id <> ?

             INNER JOIN users u
                ON u.id = other.user_id

             ORDER BY COALESCE(
                (
                    SELECT MAX(m.id)
                    FROM messages m
                    WHERE m.conversation_id = c.id
                ),
                c.id
             ) DESC`,
            [userId, userId]
        );

        return res.json({
            success: true,
            conversations
        });

    } catch (error) {
        console.error('Conversation list error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not load conversations.'
        });
    }
});


// ========================================
// START OR OPEN A CONVERSATION
// POST /api/chat/conversations
// Body: { "userId": 2 }
// ========================================
router.post('/conversations', async (req, res) => {
    let connection;

    try {
        const currentUserId = Number(req.session.userId);
        const otherUserId = Number(req.body.userId);

        if (
            !Number.isSafeInteger(otherUserId) ||
            otherUserId <= 0 ||
            otherUserId === currentUserId
        ) {
            return res.status(400).json({
                success: false,
                message: 'Choose a valid user.'
            });
        }

        connection = await pool.getConnection();

        await connection.beginTransaction();

        const [users] = await connection.execute(
            `SELECT id
             FROM users
             WHERE id = ?
               AND is_verified = 1
               AND is_active = 1
             LIMIT 1`,
            [otherUserId]
        );

        if (users.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: 'That user was not found or is unavailable.'
            });
        }

        // Reuse an existing conversation between these users.
        const [existing] = await connection.execute(
            `SELECT mine.conversation_id
             FROM conversation_members mine
             INNER JOIN conversation_members other
                ON other.conversation_id = mine.conversation_id
             WHERE mine.user_id = ?
               AND other.user_id = ?
             LIMIT 1`,
            [currentUserId, otherUserId]
        );

        if (existing.length > 0) {
            await connection.commit();

            return res.json({
                success: true,
                conversationId: existing[0].conversation_id
            });
        }

        // Create a new conversation.
        const [created] = await connection.execute(
            'INSERT INTO conversations () VALUES ()'
        );

        const conversationId = created.insertId;

        // Add both users to the conversation.
        await connection.execute(
            `INSERT INTO conversation_members
                (conversation_id, user_id)
             VALUES (?, ?), (?, ?)`,
            [
                conversationId,
                currentUserId,
                conversationId,
                otherUserId
            ]
        );

        await connection.commit();

        return res.status(201).json({
            success: true,
            conversationId
        });

    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error('Create conversation error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not start the conversation.'
        });

    } finally {
        if (connection) {
            connection.release();
        }
    }
});


// ========================================
// GET MESSAGES
// GET /api/chat/conversations/:id/messages
// ========================================
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const conversationId = Number(req.params.id);
        const userId = Number(req.session.userId);

        if (
            !Number.isSafeInteger(conversationId) ||
            conversationId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid conversation.'
            });
        }

        // Confirm that the user belongs to this conversation.
        const [membership] = await pool.execute(
            `SELECT conversation_id
             FROM conversation_members
             WHERE conversation_id = ?
               AND user_id = ?
             LIMIT 1`,
            [conversationId, userId]
        );

        if (membership.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this conversation.'
            });
        }

        // Include message text, picture/video information,
// delivery status, and read timestamps.
const [messages] = await pool.execute(
    `SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.message_text,
        m.message_type,
        m.media_url,
        m.media_mime,
        m.media_size,
        m.created_at,
        m.edited_at,
        m.delivered_at,
        m.read_at,
        u.username,
        u.full_name,
        u.profile_picture
     FROM messages m
     INNER JOIN users u
        ON u.id = m.sender_id
     WHERE m.conversation_id = ?
     ORDER BY m.id ASC
     LIMIT 200`,
    [conversationId]
);

        return res.json({
            success: true,
            messages
        });

    } catch (error) {
        console.error('Load messages error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not load messages.'
        });
    }
});


// ========================================
// SEND A MESSAGE
// POST /api/chat/conversations/:id/messages
// Body: { "message": "Hello!" }
// ========================================
router.post('/conversations/:id/messages', async (req, res) => {
    try {
        const conversationId = Number(req.params.id);
        const userId = Number(req.session.userId);

        const message = typeof req.body.message === 'string'
            ? req.body.message.trim()
            : '';

        if (
            !Number.isSafeInteger(conversationId) ||
            conversationId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid conversation.'
            });
        }

        if (!message || message.length > 5000) {
            return res.status(400).json({
                success: false,
                message: 'Messages must contain between 1 and 5000 characters.'
            });
        }

        // Confirm that the user belongs to this conversation.
        const [membership] = await pool.execute(
            `SELECT conversation_id
             FROM conversation_members
             WHERE conversation_id = ?
               AND user_id = ?
             LIMIT 1`,
            [conversationId, userId]
        );

        if (membership.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this conversation.'
            });
        }

        // Save the message.
        const [result] = await pool.execute(
            `INSERT INTO messages
                (conversation_id, sender_id, message_text)
             VALUES (?, ?, ?)`,
            [conversationId, userId, message]
        );

        // Update the conversation timestamp.
        await pool.execute(
            `UPDATE conversations
             SET updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [conversationId]
        );

        // Retrieve the saved message with its receipt timestamps.
        const [rows] = await pool.execute(
            `SELECT
                m.id,
                m.conversation_id,
                m.sender_id,
                m.message_text,
                m.created_at,
                m.edited_at,
                m.delivered_at,
                m.read_at,
                u.username,
                u.full_name,
                u.profile_picture
             FROM messages m
             INNER JOIN users u
                ON u.id = m.sender_id
             WHERE m.id = ?`,
            [result.insertId]
        );

        const newMessage = rows[0];

        // Notify connected clients through Socket.IO.
        const io = req.app.get('io');

        if (io) {
            io.to(`conversation:${conversationId}`)
                .emit('message:new', newMessage);
        }

        return res.status(201).json({
            success: true,
            message: newMessage
        });

    } catch (error) {
        console.error('Send message error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not send your message.'
        });
    }
});



// ========================================
// MARK MESSAGES AS READ
// POST /api/chat/conversations/:id/read
// ========================================
router.post('/conversations/:id/read', async (req, res) => {
    try {
        const conversationId = Number(req.params.id);
        const userId = Number(req.session.userId);

        if (
            !Number.isSafeInteger(conversationId) ||
            conversationId <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid conversation.'
            });
        }

        // Confirm that the logged-in user belongs to this conversation.
        const [membership] = await pool.execute(
            `SELECT conversation_id
             FROM conversation_members
             WHERE conversation_id = ?
               AND user_id = ?
             LIMIT 1`,
            [conversationId, userId]
        );

        if (membership.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this conversation.'
            });
        }

        // Find incoming messages that have not yet been read.
        const [unreadMessages] = await pool.execute(
            `SELECT id
             FROM messages
             WHERE conversation_id = ?
               AND sender_id <> ?
               AND read_at IS NULL`,
            [conversationId, userId]
        );

        // Mark incoming messages as delivered and read.
        await pool.execute(
            `UPDATE messages
             SET delivered_at = COALESCE(
                     delivered_at,
                     CURRENT_TIMESTAMP
                 ),
                 read_at = COALESCE(
                     read_at,
                     CURRENT_TIMESTAMP
                 )
             WHERE conversation_id = ?
               AND sender_id <> ?
               AND read_at IS NULL`,
            [conversationId, userId]
        );

        // Notify connected participants that messages were read.
        const io = req.app.get('io');

        if (io && unreadMessages.length > 0) {
            io.to(`conversation:${conversationId}`).emit(
                'messages:read',
                {
                    conversationId,
                    readerId: userId,
                    messageIds: unreadMessages.map(
                        message => Number(message.id)
                    )
                }
            );
        }

        return res.json({
            success: true,
            message: 'Messages marked as read.',
            messageIds: unreadMessages.map(
                message => Number(message.id)
            )
        });

    } catch (error) {
        console.error('Mark messages as read error:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Could not update read receipts.'
        });
    }
});

// ========================================
// UPLOAD A PICTURE OR VIDEO
// POST /api/chat/conversations/:id/media
// ========================================
router.post(
    '/conversations/:id/media',
    (req, res, next) => {
        uploadMedia.single('media')(req, res, error => {
            if (!error) {
                return next();
            }

            if (error instanceof multer.MulterError) {
                const message = error.code === 'LIMIT_FILE_SIZE'
                    ? 'The file is too large. Maximum size is 50 MB.'
                    : 'The file could not be uploaded.';

                return res.status(400).json({
                    success: false,
                    message
                });
            }

            return res.status(400).json({
                success: false,
                message: error.message || 'Invalid media file.'
            });
        });
    },
    async (req, res) => {
        let uploadedFilePath = null;

        try {
            const conversationId = Number(req.params.id);
            const userId = Number(req.session.userId);

            if (
                !Number.isSafeInteger(conversationId) ||
                conversationId <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid conversation.'
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select a picture or video.'
                });
            }

            uploadedFilePath = req.file.path;

            // Confirm that the sender belongs to this conversation.
            const [membership] = await pool.execute(
                `SELECT conversation_id
                 FROM conversation_members
                 WHERE conversation_id = ?
                   AND user_id = ?
                 LIMIT 1`,
                [conversationId, userId]
            );

            if (membership.length === 0) {
                const fs = require('fs');

                fs.unlink(uploadedFilePath, () => {});

                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to this conversation.'
                });
            }
            const messageType = req.file.mimetype.startsWith('image/')
? 'image'
: req.file.mimetype.startsWith('audio/')
? 'audio'
: 'video';


            const mediaUrl = `/uploads/${req.file.filename}`;

            // Save the attachment as a message.
            const [result] = await pool.execute(
                `INSERT INTO messages
                    (
                        conversation_id,
                        sender_id,
                        message_text,
                        message_type,
                        media_url,
                        media_mime,
                        media_size
                    )
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    conversationId,
                    userId,
                    '',
                    messageType,
                    mediaUrl,
                    req.file.mimetype,
                    req.file.size
                ]
            );

            await pool.execute(
                `UPDATE conversations
                 SET updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [conversationId]
            );

            // Retrieve the saved message.
            const [rows] = await pool.execute(
                `SELECT
                    m.id,
                    m.conversation_id,
                    m.sender_id,
                    m.message_text,
                    m.message_type,
                    m.media_url,
                    m.media_mime,
                    m.media_size,
                    m.created_at,
                    m.edited_at,
                    m.delivered_at,
                    m.read_at,
                    u.username,
                    u.full_name,
                    u.profile_picture
                 FROM messages m
                 INNER JOIN users u
                    ON u.id = m.sender_id
                 WHERE m.id = ?`,
                [result.insertId]
            );

            const newMessage = rows[0];

            // Notify clients already connected to this conversation.
            const io = req.app.get('io');

            if (io) {
                io.to(`conversation:${conversationId}`)
                    .emit('message:new', newMessage);
            }

            return res.status(201).json({
                success: true,
                message: newMessage
            });

        } catch (error) {
            console.error('Media upload error:', error.message);

            if (uploadedFilePath) {
                const fs = require('fs');

                fs.unlink(uploadedFilePath, () => {});
            }

            return res.status(500).json({
                success: false,
                message: 'Could not upload the picture or video.'
            });
        }
    }
);


module.exports = router;