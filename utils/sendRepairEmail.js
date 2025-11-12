const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();

/**
 * 🧾 Send confirmation or custom email
 * Used for both user and provider repair emails.
 */
const sendRepairEmail = async (toEmail, htmlContent, image_urls = []) => {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const sender = {
    name: 'Tajer Support',
    email: 'support@tajernow.com',
  };

  const email = {
    sender,
    to: [{ email: toEmail }],
    subject: 'Your Repair Request Is Being Processed',
    htmlContent: htmlContent, // ✅ use the HTML passed from routes
  };

  try {
    const response = await apiInstance.sendTransacEmail(email);
    console.log(`✅ Repair email sent to ${toEmail}`);
    return response;
  } catch (error) {
    console.error('❌ Error sending repair email:', error?.response?.body || error.message);
  }
};

/**
 * 🔧 Send notification email to the service provider
 * when the customer completes payment for their repair.
 */
const sendProviderNotification = async (toEmail, details) => {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const sender = {
    name: 'Tajer Notifications',
    email: 'support@tajernow.com',
  };

  const email = {
    sender,
    to: [{ email: toEmail }],
    subject: `New Paid Repair Request - ${details.description}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>🔧 New Paid Repair Request</h2>
        <p>A customer has paid for their repair. Please prepare to visit the location below:</p>

        <ul style="list-style: none; padding: 0;">
          <li><strong>📍 Address:</strong> ${details.customer_address}</li>
          <li><strong>🕒 Preferred Time:</strong> ${details.preferred_time}</li>
          <li><strong>💬 Description:</strong> ${details.description}</li>
          <li><strong>📧 Customer Email:</strong> ${details.requester_email}</li>
        </ul>

        <p style="margin-top:15px;">Please reach out to the customer to confirm your visit.</p>
        <hr style="margin-top:25px;">
        <p style="font-size: 12px; color: gray;">
          This message was sent automatically by <strong>Tajer</strong> to notify you of a paid repair.
        </p>
      </div>
    `,
  };

  try {
    const response = await apiInstance.sendTransacEmail(email);
    console.log(`📧 Provider notification sent to ${toEmail}`);
    return response;
  } catch (error) {
    console.error('❌ Error sending provider email:', error?.response?.body || error.message);
  }
};

module.exports = { sendRepairEmail, sendProviderNotification };
