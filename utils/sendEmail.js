const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();

const sendResetEmail = async (toEmail, resetLink) => {
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  SibApiV3Sdk.ApiClient.instance.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  const sender = { email: 'support@tajernow.com', name: 'Tajer' };
  const receivers = [{ email: toEmail }];

  try {
    await apiInstance.sendTransacEmail({
      sender,
      to: receivers,
      subject: 'Reset your password',
      htmlContent: `<p>Hello,</p><p>Click the link below to reset your password:</p><a href="${resetLink}">${resetLink}</a>`,
    });

    console.log(`Password reset email sent to ${toEmail}`);
  } catch (error) {
    console.error('Error sending email:', error);
  }
};

module.exports = sendResetEmail;
