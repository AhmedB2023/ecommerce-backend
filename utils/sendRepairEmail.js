const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();

const sendRepairEmail = async (toEmail, description, image_urls = []) => {
  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const sender = {
    name: 'Tajer Support',
    email: 'support@tajernow.com'
  };

  const email = {
    sender,
    to: [{ email: toEmail }],
    subject: 'Your Repair Request Is Being Processed',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Hi there 👋</h2>
        <p>We’ve received your repair request:</p>
        <blockquote style="border-left: 3px solid #007bff; padding-left: 10px; margin: 10px 0;">
          ${description}
        </blockquote>
        
        ${
          image_urls.length > 0
            ? `<div style="margin-top:15px;">
                <p>🖼 Attached images:</p>
                <div style="display:flex;flex-wrap:wrap;gap:10px;">
                  ${image_urls
                    .map(
                      (url) =>
                        `<img src="${url}" alt="repair" style="width:120px;border-radius:8px;border:1px solid #ddd;">`
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        <p style="margin-top:20px;">Our service providers will review your request shortly and may contact you for a quote.</p>
        <p>Thank you for using <strong>Tajer</strong>! We’re here to make your repair experience easier.</p>
        <hr style="margin-top:25px;">
        <p style="font-size: 12px; color: gray;">
          This is an automated message from <strong>Tajer</strong><br>
          📧 <a href="mailto:support@tajernow.com">support@tajernow.com</a>
        </p>
      </div>
    `
  };

  try {
    const response = await apiInstance.sendTransacEmail(email);
    console.log(`✅ Repair confirmation email sent to ${toEmail}`);
    return response;
  } catch (error) {
    console.error('❌ Error sending repair email:', error?.response?.body || error.message);
  }
};

module.exports = sendRepairEmail;
