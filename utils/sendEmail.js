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
    htmlContent: `
      <p>Hello,</p>
      <p>Click the link below to reset your password:</p>
      <a href="${resetLink}">${resetLink}</a>
    `,
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
