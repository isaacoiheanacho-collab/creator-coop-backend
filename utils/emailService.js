// C:\Users\hp\creator-coop-backend\utils\emailService.js

let brevoClient = null;
let Brevo = null;

try {
  Brevo = require('@getbrevo/brevo');
  // Your version exports BrevoClient, not TransactionalEmailsApi
  if (Brevo.BrevoClient) {
    brevoClient = new Brevo.BrevoClient();
    if (process.env.BREVO_API_KEY) {
      // Set API key according to BrevoClient structure
      brevoClient.apiKey = process.env.BREVO_API_KEY;
      console.log('✅ Brevo email API initialized');
    }
  } else {
    console.warn('⚠️ Brevo module loaded but BrevoClient not found');
  }
} catch (err) {
  console.warn('⚠️ Brevo package not installed. Email sending will be simulated.');
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@creatorcooptechnologies.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Creator Co-Op';

/**
 * Generic email sender using Brevo API
 */
async function sendEmail(to, subject, htmlContent) {
  // Development mode or no Brevo: log to console
  if (!IS_PRODUCTION || !brevoClient) {
    console.log('\n📧 ===== EMAIL (DEVELOPMENT) =====');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Content preview: ${htmlContent.replace(/<[^>]*>/g, ' ').substring(0, 150)}...`);
    console.log('=================================\n');
    return { success: true };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Email sent to ${to}: ${data.messageId}`);
      return { success: true, messageId: data.messageId };
    } else {
      const error = await response.text();
      console.error('❌ Brevo API error:', error);
      return { success: false, error };
    }
  } catch (error) {
    console.error('❌ Email send error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send password reset email
 */
async function sendResetPasswordEmail(to, resetLink, username = '') {
  const subject = 'Reset Your Password - Creator Co-Op';
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 30px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 20px;">
          <span style="font-size: 24px; font-weight: bold; color: #2563eb;">Creator<span style="color:#1e293b;"> Co-Op</span></span>
        </div>
        <p>Hello${username ? ' ' + username : ''},</p>
        <p>We received a request to reset your password. Click the button below:</p>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${resetLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">Reset Password</a>
        </div>
        <p>Or copy this link: <a href="${resetLink}">${resetLink}</a></p>
        <p>This link expires in <strong>1 hour</strong>.</p>
        <p>If you didn't request this, please ignore this email.</p>
        <hr style="margin: 20px 0; border-color: #e2e8f0;">
        <p style="font-size: 12px; color: #64748b; text-align: center;">Creator Co-Op • West African Creators Network</p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(to, subject, html);
}

/**
 * Send verification OTP email for email verification
 */
async function sendVerificationEmail(to, otp, username = '') {
  const subject = 'Verify Your Email - Creator Co-Op';
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 30px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 20px;">
          <span style="font-size: 24px; font-weight: bold; color: #2563eb;">Creator<span style="color:#1e293b;"> Co-Op</span></span>
        </div>
        <p>Hello${username ? ' ' + username : ''},</p>
        <p>Thank you for joining! Please use the code below to verify your email address:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background: #f1f5f9; padding: 15px; text-align: center; border-radius: 8px; margin: 20px 0;">
          ${otp}
        </div>
        <p>This code expires in <strong>15 minutes</strong>.</p>
        <p>If you didn't create an account, please ignore this email.</p>
        <hr style="margin: 20px 0; border-color: #e2e8f0;">
        <p style="font-size: 12px; color: #64748b; text-align: center;">Creator Co-Op • West African Creators Network</p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(to, subject, html);
}

module.exports = { 
  sendEmail, 
  sendResetPasswordEmail, 
  sendVerificationEmail 
};