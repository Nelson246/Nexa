const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: Number(process.env.SMTP_PORT || 465) === 465,

    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Verify the email server connection
transporter.verify()
    .then(() => {
        console.log('NEXA email server connected successfully.');
    })
    .catch((error) => {
        console.error('NEXA email connection failed:', error.message);
    });


// ========================================
// SEND EMAIL VERIFICATION CODE
// ========================================
async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: `"NEXA" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Verify Your NEXA Account',
        text: `
Welcome to NEXA!

Your email verification code is: ${code}

Enter this code on the NEXA registration page to verify your account.

If you did not create a NEXA account, you can ignore this email.
        `,
        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #ddd;border-radius:12px;">
                <h1 style="color:#1769ff;text-align:center;">NEXA</h1>

                <h2>Verify Your Account</h2>

                <p>Welcome to NEXA! Use the verification code below to verify your email address.</p>

                <div style="background:#f0f5ff;padding:20px;text-align:center;border-radius:8px;">
                    <h1 style="letter-spacing:8px;color:#1769ff;">${code}</h1>
                </div>

                <p>If you did not create a NEXA account, you can ignore this email.</p>

                <p style="color:#777;font-size:12px;">NEXA — Connect. Chat. Share.</p>
            </div>
        `
    };

    return transporter.sendMail(mailOptions);
}


// ========================================
// SEND PASSWORD RESET EMAIL
// ========================================
async function sendPasswordResetEmail(email, resetUrl) {
    const mailOptions = {
        from: `"NEXA" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Reset Your NEXA Password',

        text: `
You requested to reset your NEXA password.

Open the following link to create a new password:

${resetUrl}

This link expires in 15 minutes.

If you did not request a password reset, ignore this email.
        `,

        html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;border:1px solid #ddd;border-radius:12px;">
                <h1 style="color:#1769ff;text-align:center;">NEXA</h1>

                <h2>Reset Your Password</h2>

                <p>We received a request to reset your NEXA account password.</p>

                <p>Click the button below to choose a new password.</p>

                <div style="text-align:center;margin:30px 0;">
                    <a href="${resetUrl}"
                       style="background:#1769ff;color:white;padding:14px 25px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;">
                        Reset Password
                    </a>
                </div>

                <p>This link expires in <strong>15 minutes</strong>.</p>

                <p>If you did not request a password reset, you can safely ignore this email.</p>

                <p style="color:#777;font-size:12px;">NEXA — Connect. Chat. Share.</p>
            </div>
        `
    };

    return transporter.sendMail(mailOptions);
}


// ========================================
// EXPORT FUNCTIONS
// ========================================
module.exports = {
    transporter,
    sendVerificationEmail,
    sendPasswordResetEmail
};