const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();

const sendResetEmail = async (toEmail, resetLink) => {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const sender = {
    name: 'Tajer',
    email: 'support@tajernow.com'
  };

  const to = [{ email: toEmail }];

  const email = {
    sender,
    to,
    subject: 'Reset your password',
    replyTo: {
      email: 'support@tajernow.com',
      name: 'Tajer Support'
    },
    headers: {
      'X-Mailer': 'Brevo-Tajer'
    },
    htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <p>Hello,</p>
        <p>You recently requested to reset your password. Click the link below to reset it:</p>
        <p><a href="${resetLink}" style="color: #1a73e8;">Reset Password</a></p>
        <p>If you didn’t request this, you can safely ignore this email.</p>
        <hr>
        <p style="font-size: 12px; color: gray;">
          This email was sent by <strong>Tajer</strong> • <a href="mailto:support@tajernow.com">support@tajernow.com</a><br>
          If you have any questions, feel free to reach out.
        </p>
      </div>
    `
  };

  try {
    const response = await apiInstance.sendTransacEmail(email);
    console.log(`✅ Password reset email sent to ${toEmail}`);
    console.log('Brevo response:', response);
  } catch (error) {
    console.error('❌ Error sending email with Brevo:', error?.response?.body || error.message || error);
  }
};

module.exports = sendResetEmail;
