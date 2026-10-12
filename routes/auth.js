const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { pool } = require('../config/db');
const {
    sendVerificationEmail,
    sendPasswordResetEmail
} = require('../config/mailer');

const router = express.Router();

const CODE_EXPIRY_MINUTES = 10;
const RESEND_WAIT_SECONDS = 60;
const MAX_VERIFICATION_ATTEMPTS = 5;

// =====================================================
// HELPER FUNCTIONS
// =====================================================

// Generate a random six-digit verification code.
function generateVerificationCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

// Hash verification codes before storing them.
function hashVerificationCode(code) {
    const secret =
        process.env.SESSION_SECRET ||
        'change-this-nexa-secret-before-deployment';

    return crypto
        .createHmac('sha256', secret)
        .update(code)
        .digest('hex');
}

// Compare verification codes safely.
function codesMatch(submittedCode, storedHash) {
    if (
        typeof submittedCode !== 'string' ||
        typeof storedHash !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(storedHash)
    ) {
        return false;
    }

    const submittedHash = Buffer.from(
        hashVerificationCode(submittedCode),
        'hex'
    );

    const expectedHash = Buffer.from(storedHash, 'hex');

    return (
        submittedHash.length === expectedHash.length &&
        crypto.timingSafeEqual(submittedHash, expectedHash)
    );
}

// Validate email addresses.
function isValidEmail(email) {
    return (
        typeof email === 'string' &&
        email.length <= 255 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );
}

// =====================================================
// REGISTER A NEW ACCOUNT
// POST /api/auth/register
// =====================================================

router.post('/register', async (req, res) => {
    let connection;
    let transactionStarted = false;

    try {
        let {
            full_name,
            username,
            email,
            password,
            confirm_password,
            verification_method
        } = req.body;

        // Validate required fields.
        if (
            typeof full_name !== 'string' ||
            typeof username !== 'string' ||
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            typeof confirm_password !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please complete all required fields.'
            });
        }

        full_name = full_name.trim();
        username = username.trim().toLowerCase();
        email = email.trim().toLowerCase();

        verification_method = verification_method || 'email';

        if (!['email', 'phone'].includes(verification_method)) {
            return res.status(400).json({
                success: false,
                message: 'Please select a valid verification method.'
            });
        }

        if (verification_method === 'phone') {
            return res.status(501).json({
                success: false,
                message:
                    'Phone verification is not available yet. Please choose email verification.'
            });
        }

        // Validate name.
        if (full_name.length < 2 || full_name.length > 100) {
            return res.status(400).json({
                success: false,
                message:
                    'Your name must be between 2 and 100 characters.'
            });
        }

        // Validate username.
        if (!/^[a-z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({
                success: false,
                message:
                    'Username must be 3–30 characters using letters, numbers, or underscores.'
            });
        }

        // Validate email.
        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address.'
            });
        }

        // Validate password.
        if (
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Your password must contain at least 8 characters and no more than 72 UTF-8 bytes.'
            });
        }

        if (password !== confirm_password) {
            return res.status(400).json({
                success: false,
                message: 'Your passwords do not match.'
            });
        }

        // Check whether the username or email already exists.
        const [existingUsers] = await pool.execute(
            `SELECT
                id,
                username,
                email,
                is_verified
             FROM users
             WHERE username = ? OR email = ?
             LIMIT 1`,
            [username, email]
        );

        if (existingUsers.length > 0) {
            const existingUser = existingUsers[0];

            // Help an existing unverified user continue verification.
            if (!existingUser.is_verified) {
                return res.status(409).json({
                    success: false,
                    accountExists: true,
                    verificationRequired: true,
                    message:
                        'An account with this username or email already exists and may need verification. Use the verification option to request a new code.'
                });
            }

            return res.status(409).json({
                success: false,
                accountExists: true,
                message:
                    'That username or email is already registered. Please log in or use Forgot Password.'
            });
        }

        // Securely hash the password.
        const passwordHash = await bcrypt.hash(password, 12);

        // Generate and hash the verification code.
        const verificationCode = generateVerificationCode();
        const verificationCodeHash =
            hashVerificationCode(verificationCode);

        // Create the account and settings in one transaction.
        connection = await pool.getConnection();

        await connection.beginTransaction();
        transactionStarted = true;

        const [result] = await connection.execute(
            `INSERT INTO users (
                full_name,
                username,
                email,
                password_hash,
                is_verified,
                verification_method,
                verification_code_hash,
                verification_expires_at,
                verification_attempts,
                last_verification_sent_at
            )
            VALUES (
                ?, ?, ?, ?, FALSE, 'email', ?, 
                DATE_ADD(NOW(), INTERVAL ${CODE_EXPIRY_MINUTES} MINUTE),
                0,
                NOW()
            )`,
            [
                full_name,
                username,
                email,
                passwordHash,
                verificationCodeHash
            ]
        );

        const userId = result.insertId;

        await connection.execute(
            'INSERT INTO user_settings (user_id) VALUES (?)',
            [userId]
        );

        await connection.commit();
        transactionStarted = false;

        connection.release();
        connection = null;

        // Send the verification email after saving the account.
        try {
            await sendVerificationEmail(email, verificationCode);
        } catch (emailError) {
            console.error(
                'NEXA verification email error:',
                emailError.message
            );

            return res.status(503).json({
                success: false,
                accountCreated: true,
                verificationRequired: true,
                message:
                    'Your account was created, but the verification email could not be sent. Please request a new code.'
            });
        }

        return res.status(201).json({
            success: true,
            verificationRequired: true,
            message:
                'Your account has been created. Check your email for your six-digit verification code.',
            user: {
                id: userId,
                full_name,
                username,
                email
            }
        });
    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    'NEXA transaction rollback error:',
                    rollbackError.message
                );
            }
        }

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                success: false,
                message:
                    'That username or email is already registered.'
            });
        }

        console.error(
            'NEXA registration error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'Something went wrong while creating your account. Please try again.'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// =====================================================
// VERIFY EMAIL ADDRESS
// POST /api/auth/verify-email
// =====================================================

router.post('/verify-email', async (req, res) => {
    try {
        let { email, code } = req.body;

        if (
            typeof email !== 'string' ||
            typeof code !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Enter your email address and verification code.'
            });
        }

        email = email.trim().toLowerCase();
        code = code.trim();

        if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
            return res.status(400).json({
                success: false,
                message:
                    'Enter a valid email address and six-digit code.'
            });
        }

        // Find the account.
        const [users] = await pool.execute(
            `SELECT
                id,
                is_verified,
                verification_code_hash,
                verification_expires_at,
                verification_attempts
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (users.length === 0) {
            return res.status(400).json({
                success: false,
                message:
                    'The email address or verification code is invalid.'
            });
        }

        const user = users[0];

        // Do not require a code for an already verified account.
        if (Boolean(user.is_verified)) {
            return res.json({
                success: true,
                message:
                    'Your email is already verified. You can log in.'
            });
        }

        // Ensure an active code exists.
        if (
            !user.verification_code_hash ||
            !user.verification_expires_at
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'No active verification code was found. Please request a new one.'
            });
        }

        // Limit incorrect attempts.
        if (
            Number(user.verification_attempts) >=
            MAX_VERIFICATION_ATTEMPTS
        ) {
            return res.status(429).json({
                success: false,
                message:
                    'Too many incorrect attempts. Please request a new verification code.'
            });
        }

        // Check expiry using the database server's clock.
        const [expiryRows] = await pool.execute(
            `SELECT
                verification_expires_at > NOW() AS is_valid
             FROM users
             WHERE id = ?`,
            [user.id]
        );

        const codeIsUnexpired =
            expiryRows.length > 0 &&
            Boolean(expiryRows[0].is_valid);

        if (!codeIsUnexpired) {
            return res.status(400).json({
                success: false,
                message:
                    'Your verification code has expired. Please request a new one.'
            });
        }

        // Check the submitted code.
        if (
            !codesMatch(
                code,
                user.verification_code_hash
            )
        ) {
            await pool.execute(
                `UPDATE users
                 SET verification_attempts = verification_attempts + 1
                 WHERE id = ?
                   AND is_verified = FALSE`,
                [user.id]
            );

            return res.status(400).json({
                success: false,
                message:
                    'The verification code is incorrect.'
            });
        }

        // Mark the account as verified and invalidate the code.
        await pool.execute(
            `UPDATE users
             SET
                is_verified = TRUE,
                verified_at = NOW(),
                verification_code_hash = NULL,
                verification_expires_at = NULL,
                verification_attempts = 0
             WHERE id = ?
               AND is_verified = FALSE`,
            [user.id]
        );

        return res.json({
            success: true,
            message:
                'Your email has been verified successfully! You can now log in.'
        });
    } catch (error) {
        console.error(
            'NEXA email verification error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'We could not verify your email right now. Please try again.'
        });
    }
});

// =====================================================
// RESEND EMAIL VERIFICATION CODE
// POST /api/auth/resend-code
// =====================================================

router.post('/resend-code', async (req, res) => {
    try {
        let { email } = req.body;

        if (typeof email !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Please enter your email address.'
            });
        }

        email = email.trim().toLowerCase();

        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address.'
            });
        }

        // Find the account.
        const [users] = await pool.execute(
            `SELECT
                id,
                is_verified,
                last_verification_sent_at
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        // Use a generic response to avoid exposing account details.
        const genericResponse = {
            success: true,
            message:
                'If your account needs verification, a new code will be sent when permitted.'
        };

        if (
            users.length === 0 ||
            Boolean(users[0].is_verified)
        ) {
            return res.json(genericResponse);
        }

        const user = users[0];

        // Enforce the resend waiting period.
        if (user.last_verification_sent_at) {
            const [waitRows] = await pool.execute(
                `SELECT TIMESTAMPDIFF(
                    SECOND,
                    last_verification_sent_at,
                    NOW()
                ) AS elapsed
                FROM users
                WHERE id = ?`,
                [user.id]
            );

            if (
                waitRows.length > 0 &&
                waitRows[0].elapsed !== null &&
                Number(waitRows[0].elapsed) <
                    RESEND_WAIT_SECONDS
            ) {
                return res.status(429).json({
                    success: false,
                    message:
                        'Please wait one minute before requesting another code.'
                });
            }
        }

        // Generate a new verification code.
        const code = generateVerificationCode();
        const codeHash = hashVerificationCode(code);

        // Save the new code and its expiry.
        const [updateResult] = await pool.execute(
            `UPDATE users
             SET
                verification_code_hash = ?,
                verification_expires_at =
                    DATE_ADD(
                        NOW(),
                        INTERVAL ${CODE_EXPIRY_MINUTES} MINUTE
                    ),
                verification_attempts = 0,
                last_verification_sent_at = NOW()
             WHERE id = ?
               AND is_verified = FALSE`,
            [codeHash, user.id]
        );

        if (updateResult.affectedRows === 0) {
            return res.json(genericResponse);
        }

        // Send the new code.
        try {
            await sendVerificationEmail(email, code);
        } catch (emailError) {
            console.error(
                'NEXA resend email error:',
                emailError.message
            );

            return res.status(503).json({
                success: false,
                message:
                    'The verification email could not be sent. Please try again later.'
            });
        }

        return res.json(genericResponse);
    } catch (error) {
        console.error(
            'NEXA resend verification error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'We could not send a new verification code. Please try again.'
        });
    }
});

// =====================================================
// LOGIN
// POST /api/auth/login
// =====================================================

router.post('/login', async (req, res) => {
    try {
        let { identifier, password } = req.body;

        if (
            typeof identifier !== 'string' ||
            typeof password !== 'string' ||
            !identifier.trim() ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message: 'Enter your email or username and password.'
            });
        }

        identifier = identifier.trim().toLowerCase();

        // Find the account by email or username.
        const [users] = await pool.execute(
            `SELECT
                id,
                full_name,
                username,
                email,
                password_hash,
                is_verified,
                is_active,
                profile_picture,
                bio
             FROM users
             WHERE email = ? OR username = ?
             LIMIT 1`,
            [identifier, identifier]
        );

        // Use a generic error for invalid credentials.
        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Incorrect email/username or password.'
            });
        }

        const user = users[0];

        // Check the password.
        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message: 'Incorrect email/username or password.'
            });
        }

        // Do not allow unverified accounts to log in.
        if (!Boolean(user.is_verified)) {
            return res.status(403).json({
                success: false,
                verificationRequired: true,
                message:
                    'Your email has not been verified. Please request a verification code before logging in.'
            });
        }

        // Respect account status if the account is disabled.
        if (
            user.is_active !== undefined &&
            user.is_active !== null &&
            !Boolean(user.is_active)
        ) {
            return res.status(403).json({
                success: false,
                message: 'Your account is currently inactive.'
            });
        }

        // Regenerate the session to reduce session-fixation risk.
        req.session.regenerate((sessionError) => {
            if (sessionError) {
                console.error(
                    'NEXA session error:',
                    sessionError.message
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to start your session. Please try again.'
                });
            }

            // Store the authenticated user's ID in the session.
            req.session.userId = user.id;
            req.session.user = {
                id: user.id,
                full_name: user.full_name,
                username: user.username,
                email: user.email,
                profile_picture: user.profile_picture,
                bio: user.bio
            };

            req.session.save((saveError) => {
                if (saveError) {
                    console.error(
                        'NEXA session save error:',
                        saveError.message
                    );

                    return res.status(500).json({
                        success: false,
                        message: 'Unable to save your login session.'
                    });
                }

                return res.json({
                    success: true,
                    message: 'Login successful!',
                    redirect: '/chat.html',
                    user: req.session.user
                });
            });
        });

    } catch (error) {
        console.error(
            'NEXA login error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message: 'A server error occurred while logging in.'
        });
    }
});



// =====================================================
// REQUEST PASSWORD RESET
// POST /api/auth/forgot-password
// =====================================================

router.post('/forgot-password', async (req, res) => {
    try {
        let { email } = req.body;

        const genericResponse = {
            success: true,
            message:
                'If an account exists for that email, a password-reset link will be sent.'
        };

        if (typeof email !== 'string') {
            return res.json(genericResponse);
        }

        email = email.trim().toLowerCase();

        if (!isValidEmail(email)) {
            return res.json(genericResponse);
        }

        const [users] = await pool.execute(
            `SELECT id, email, is_verified
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (
            users.length === 0 ||
            !Boolean(users[0].is_verified)
        ) {
            return res.json(genericResponse);
        }

        const user = users[0];

        // Generate a cryptographically secure, single-use token.
        const token = crypto.randomBytes(32).toString('hex');

        const tokenHash = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        await pool.execute(
            `UPDATE users
             SET
                password_reset_token_hash = ?,
                password_reset_expires_at =
                    DATE_ADD(NOW(), INTERVAL 15 MINUTE)
             WHERE id = ?`,
            [tokenHash, user.id]
        );

        // Use the configured public URL in production.
        const baseUrl = (
            process.env.APP_URL ||
            'http://localhost:3000'
        ).replace(/\/+$/, '');

        const resetUrl =
            `${baseUrl}/reset-password.html?token=${token}`;

        try {
            await sendPasswordResetEmail(email, resetUrl);
        } catch (emailError) {
            // Invalidate the token if delivery fails.
            await pool.execute(
                `UPDATE users
                 SET
                    password_reset_token_hash = NULL,
                    password_reset_expires_at = NULL
                 WHERE id = ?`,
                [user.id]
            );

            console.error(
                'NEXA password-reset email error:',
                emailError.message
            );

            return res.status(503).json({
                success: false,
                message:
                    'We could not send the reset email. Please try again later.'
            });
        }

        return res.json(genericResponse);
    } catch (error) {
        console.error(
            'NEXA forgot-password error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'We could not process your request right now.'
        });
    }
});

// =====================================================
// RESET PASSWORD
// POST /api/auth/reset-password
// =====================================================

router.post('/reset-password', async (req, res) => {
    let connection;

    try {
        const { token, password, confirm_password } = req.body;

        if (
            typeof token !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(token) ||
            typeof password !== 'string' ||
            typeof confirm_password !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please provide valid reset details.'
            });
        }

        if (
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Your password must contain at least 8 characters and no more than 72 UTF-8 bytes.'
            });
        }

        if (password !== confirm_password) {
            return res.status(400).json({
                success: false,
                message: 'Your passwords do not match.'
            });
        }

        const tokenHash = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        const passwordHash = await bcrypt.hash(password, 12);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [users] = await connection.execute(
            `SELECT id
             FROM users
             WHERE password_reset_token_hash = ?
               AND password_reset_expires_at > NOW()
             LIMIT 1
             FOR UPDATE`,
            [tokenHash]
        );

        if (users.length === 0) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message:
                    'This password-reset link is invalid or has expired. Please request a new one.'
            });
        }

        const userId = users[0].id;

        await connection.execute(
            `UPDATE users
             SET
                password_hash = ?,
                password_reset_token_hash = NULL,
                password_reset_expires_at = NULL
             WHERE id = ?`,
            [passwordHash, userId]
        );

        await connection.commit();

        return res.json({
            success: true,
            message:
                'Your password has been reset successfully. You can now log in.'
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    'NEXA password-reset rollback error:',
                    rollbackError.message
                );
            }
        }

        console.error(
            'NEXA reset-password error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            message:
                'We could not reset your password right now. Please try again.'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});


// ========================================
// GET CURRENT LOGGED-IN USER
// GET /api/auth/me
// ========================================
router.get('/me', async (req, res) => {
    try {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({
                success: false,
                message: 'Please log in to continue.'
            });
        }

        const [users] = await pool.execute(
            `SELECT
                id,
                full_name,
                username,
                email,
                profile_picture,
                bio,
                is_verified,
                created_at
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [req.session.userId]
        );

        if (users.length === 0) {
            req.session.destroy(() => {});

            return res.status(401).json({
                success: false,
                message: 'Your account could not be found. Please log in again.'
            });
        }

        res.json({
            success: true,
            user: users[0]
        });

    } catch (error) {
        console.error('Get current user error:', error.message);

        res.status(500).json({
            success: false,
            message: 'Could not load your account.'
        });
    }
});


// ========================================
// LOG OUT
// POST /api/auth/logout
// ========================================
router.post('/logout', (req, res) => {
    if (!req.session) {
        return res.json({
            success: true,
            message: 'You have been logged out.'
        });
    }

    req.session.destroy((error) => {
        if (error) {
            console.error('Logout error:', error.message);

            return res.status(500).json({
                success: false,
                message: 'Could not log out. Please try again.'
            });
        }

        res.clearCookie('connect.sid', {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production'
        });

        res.json({
            success: true,
            message: 'You have been logged out successfully.'
        });
    });
});


// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;