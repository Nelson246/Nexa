require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const { Server } = require('socket.io');

const { testConnection, pool } = require('./config/db');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET ||
        'change-this-nexa-secret-before-deployment',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24
    }
});

const io = new Server(server);

// Track connected devices for each user.
const onlineUsers = new Map();

app.set('io', io);
app.set('onlineUsers', onlineUsers);

// ========================================
// MIDDLEWARE
// ========================================

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(sessionMiddleware);

// ========================================
// ROUTES
// ========================================

// Authentication routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Messaging routes
const chatRoutes = require('./routes/chat');
app.use('/api/chat', chatRoutes);

// Static website files
app.use(express.static(path.join(__dirname, 'public')));

// Homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        application: 'NEXA',
        message: 'NEXA server is running!'
    });
});

// ========================================
// SOCKET.IO SESSION AUTHENTICATION
// ========================================

// Share the existing login session with Socket.IO.
io.engine.use(sessionMiddleware);

// Authenticate Socket.IO connections.
io.use((socket, next) => {
    const session = socket.request.session;

    if (!session || !session.userId) {
        return next(new Error('Authentication required.'));
    }

    socket.userId = Number(session.userId);
    next();
});

// ========================================
// NEXA ONLINE PRESENCE
// ========================================

async function notifyConversationPartners(userId, isOnline) {
    try {
        const [partners] = await pool.execute(
            `SELECT DISTINCT other.user_id
             FROM conversation_members mine
             INNER JOIN conversation_members other
                ON other.conversation_id = mine.conversation_id
             WHERE mine.user_id = ?
               AND other.user_id <> ?`,
            [userId, userId]
        );

        let lastSeenAt = null;

        if (!isOnline) {
            const [users] = await pool.execute(
                `SELECT last_seen_at
                 FROM users
                 WHERE id = ?
                 LIMIT 1`,
                [userId]
            );

            lastSeenAt = users.length ? users[0].last_seen_at : null;
        }

        const update = {
            userId: Number(userId),
            online: Boolean(isOnline),
            lastSeenAt
        };

        for (const partner of partners) {
            const partnerId = Number(partner.user_id);

            io.to(`user:${partnerId}`).emit(
                'presence:update',
                update
            );
        }

        console.log('NEXA: Presence broadcast:', update);

    } catch (error) {
        console.error(
            'NEXA presence notification failed:',
            error.message
        );
    }
}

// ========================================
// REAL-TIME MESSAGING AND CALL SIGNALING
// ========================================

io.on('connection', (socket) => {
    const userId = Number(socket.userId);

    console.log('Authenticated device connected:', socket.id);

    // Register this connected device.
    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
    }

    const devices = onlineUsers.get(userId);
    devices.add(socket.id);

    // Each user joins their personal room.
    socket.join(`user:${userId}`);

    // Send the current presence of conversation partners to this device.
(async () => {
    try {
        const [partners] = await pool.execute(
            `SELECT DISTINCT
                    other.user_id AS userId,
                    u.last_seen_at AS lastSeenAt
             FROM conversation_members mine
             INNER JOIN conversation_members other
                ON other.conversation_id = mine.conversation_id
             INNER JOIN users u
                ON u.id = other.user_id
             WHERE mine.user_id = ?
               AND other.user_id <> ?`,
            [userId, userId]
        );

        for (const partner of partners) {
            const partnerId = Number(partner.userId);
            const online = onlineUsers.has(partnerId);

            socket.emit('presence:update', {
                userId: partnerId,
                online,
                lastSeenAt: online ? null : partner.lastSeenAt
            });
        }

        console.log(
            'NEXA: Initial contact presence sent to user:',
            userId
        );

    } catch (error) {
        console.error(
            'NEXA initial presence error:',
            error.message
        );
    }
})();

    console.log('NEXA: Device joined user room:', {
        socketId: socket.id,
        userId,
        rooms: [...socket.rooms]
    });

    // Notify conversation partners when the first device connects.
    if (devices.size === 1) {
        notifyConversationPartners(userId, true);
    }

    // ========================================
    // JOIN A CONVERSATION
    // ========================================

    socket.on('conversation:join', async (conversationId) => {
        try {
            const id = Number(conversationId);

            if (!Number.isSafeInteger(id) || id <= 0) {
                return;
            }

            // Only conversation members can join its Socket.IO room.
            const [membership] = await pool.execute(
                `SELECT conversation_id
                 FROM conversation_members
                 WHERE conversation_id = ?
                   AND user_id = ?
                 LIMIT 1`,
                [id, userId]
            );

            if (membership.length > 0) {
                socket.join(`conversation:${id}`);

                console.log('NEXA: Joined conversation:', {
                    userId,
                    conversationId: id
                });
            }
        } catch (error) {
            console.error(
                'Socket conversation join failed:',
                error.message
            );
        }
    });

    // ========================================
// TYPING INDICATORS
// ========================================

socket.on('typing:start', (data) => {
    try {
        const conversationId = Number(data?.conversationId);
        const room = `conversation:${conversationId}`;

        if (
            !Number.isSafeInteger(conversationId) ||
            conversationId <= 0 ||
            !socket.rooms.has(room)
        ) {
            return;
        }

        // Notify the other participants, not this socket.
        socket.to(room).emit('typing:update', {
            conversationId,
            userId,
            typing: true
        });

    } catch (error) {
        console.error('NEXA typing:start error:', error.message);
    }
});

socket.on('typing:stop', (data) => {
    try {
        const conversationId = Number(data?.conversationId);
        const room = `conversation:${conversationId}`;

        if (
            !Number.isSafeInteger(conversationId) ||
            conversationId <= 0 ||
            !socket.rooms.has(room)
        ) {
            return;
        }

        socket.to(room).emit('typing:update', {
            conversationId,
            userId,
            typing: false
        });

    } catch (error) {
        console.error('NEXA typing:stop error:', error.message);
    }
});

    // ========================================
    // VOICE AND VIDEO CALL SIGNALING
    // ========================================

    socket.on('call:signal', async (data) => {
        try {
            if (!data || typeof data !== 'object') {
                return;
            }

            const conversationId = Number(data.conversationId);
            const targetUserId = Number(data.targetUserId);
            const signalType = data.type;

            console.log('NEXA: Call signal received:', {
                from: userId,
                to: targetUserId,
                conversationId,
                type: signalType
            });

            const allowedTypes = new Set([
                'offer',
                'answer',
                'ice-candidate',
                'decline',
                'end',
                'busy'
            ]);

            if (
                !Number.isSafeInteger(conversationId) ||
                conversationId <= 0 ||
                !Number.isSafeInteger(targetUserId) ||
                targetUserId <= 0 ||
                targetUserId === userId ||
                !allowedTypes.has(signalType)
            ) {
                return;
            }

            // Confirm that both participants belong to this conversation.
            const [members] = await pool.execute(
                `SELECT user_id
                 FROM conversation_members
                 WHERE conversation_id = ?
                   AND user_id IN (?, ?)`,
                [conversationId, userId, targetUserId]
            );

            const memberIds = new Set(
                members.map(member => Number(member.user_id))
            );

            if (
                !memberIds.has(userId) ||
                !memberIds.has(targetUserId)
            ) {
                console.warn(
                    'NEXA: Rejected call signal from a non-member.'
                );
                return;
            }

            // Forward the signal to the intended participant.
            const targetRoom = `user:${targetUserId}`;

            console.log(
                'NEXA: Forwarding call to room:',
                targetRoom
            );

            io.to(targetRoom).emit('call:incoming-signal', {
                conversationId,
                fromUserId: userId,
                type: signalType,
                payload: data.payload ?? null
            });

        } catch (error) {
            console.error(
                'Call signaling error:',
                error.message
            );
        }
    });

    // ========================================
    // DEVICE DISCONNECTION AND LAST SEEN
    // ========================================

    socket.on('disconnect', async () => {
        console.log('NEXA: Device disconnected:', {
    socketId: socket.id,
    userId
});
        const devices = onlineUsers.get(userId);

        if (!devices) {
            return;
        }

        // Remove this device only.
        devices.delete(socket.id);

        // Keep the user online if another device remains connected.
      if (devices.size > 0) {
    console.log('NEXA: User still has connected devices:', {
        userId,
        remainingDevices: devices.size
    });

    return;
}

        // No devices remain connected.
        onlineUsers.delete(userId);

        try {
            await pool.execute(
                `UPDATE users
                 SET last_seen_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [userId]
            );

            await notifyConversationPartners(userId, false);

            console.log('NEXA: User is now offline:', userId);

        } catch (error) {
            console.error(
                'NEXA last-seen update failed:',
                error.message
            );
        }
    });

}); // IMPORTANT: closes io.on('connection')

// ========================================
// ERROR HANDLER
// ========================================

app.use((err, req, res, next) => {
    console.error('Server error:', err.message);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        success: false,
        message: 'An internal server error occurred.'
    });
});

// ========================================
// START SERVER
// ========================================

server.listen(PORT, async () => {
    console.log('================================');
    console.log('       NEXA SERVER STARTED');
    console.log('================================');
    console.log(`Website: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api/status`);

    await testConnection();
});

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

async function shutdown() {
    console.log('\nNEXA: Shutting down server...');

    server.close(async () => {
        try {
            await pool.end();
            console.log('NEXA: Database connection pool closed.');
        } catch (error) {
            console.error(
                'Database shutdown error:',
                error.message
            );
        }

        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);