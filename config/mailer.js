const APP_NAME = 'NEXA';

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, html, text }) {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
        throw new Error('RESEND_API_KEY is missing from environment variables.');
    }

    const fromEmail =
        process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

    const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: `${APP_NAME} <${fromEmail}>`,
            to: [to],
            subject,
            html,
            text
        })
    });

    const result = await response.json();

    if (!response.ok) {
        console.error('NEXA Resend API error:', result);

        throw new Error(
            result.message || `Email sending failed with status ${response.status}.`
        );
    }

    console.log('NEXA email accepted by Resend:', result.id);

    return result;
}

// Send the six-digit email verification code.
async function sendVerificationEmail(email, code) {
    const subject = 'Verify your NEXA account';

    const text = [
        'Welcome to NEXA!',
        '',
        `Your verification code is: ${code}`,
        '',
        'This code expires in 10 minutes.',
        'If you did not create this account, you can ignore this email.'
    ].join('\n');

    const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#222">
            <h1 style="color:#2563eb">NEXA</h1>
            <h2>Verify your email address</h2>
            <p>Welcome to NEXA! Enter the code below to verify your account.</p>
            <div style="background:#f1f5f9;padding:20px;text-align:center;border-radius:10px">
                <div style="font-size:32px;font-weight:bold;letter-spacing:8px">
                    ${code}
                </div>
            </div>
            <p>This code expires in <strong>10 minutes</strong>.</p>
            <p>If you did not create this account, you can ignore this email.</p>
        </div>
    `;

    return sendEmail({
        to: email,
        subject,
        html,
        text
    });
}

// Send the password-reset link.
async function sendPasswordResetEmail(email, resetUrl) {
    const subject = 'Reset your NEXA password';

    const text = [
        'You requested a password reset for your NEXA account.',
        '',
        `Reset your password using this link: ${resetUrl}`,
        '',
        'This link expires in 15 minutes.',
        'If you did not request a password reset, ignore this email.'
    ].join('\n');

    const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#222">
            <h1 style="color:#2563eb">NEXA</h1>
            <h2>Reset your password</h2>
            <p>You requested a password reset for your NEXA account.</p>
            <p>
                <a href="${resetUrl}"
                   style="display:inline-block;background:#2563eb;color:#fff;padding:12px 22px;text-decoration:none;border-radius:6px">
                    Reset Password
                </a>
            </p>
            <p>This link expires in <strong>15 minutes</strong>.</p>
            <p>If you did not request this, you can ignore this email.</p>
        </div>
    `;

    return sendEmail({
        to: email,
        subject,
        html,
        text
    });
}

module.exports = {
    sendVerificationEmail,
    sendPasswordResetEmail
};