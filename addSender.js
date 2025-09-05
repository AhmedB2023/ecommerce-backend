const SibApiV3Sdk = require('sib-api-v3-sdk');
require('dotenv').config();
console.log("Loaded API Key:", process.env.BREVO_API_KEY);


const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;


const apiInstance = new SibApiV3Sdk.SendersApi();

const sender = {
  name: "Tajer",
  email: "support@tajernow.com"
};

apiInstance.createSender(sender).then(
  function(data) {
    console.log("✅ Sender created. Check your inbox to verify:", data);
  },
  function(error) {
    console.error("❌ Error adding sender:", error.response?.body || error.message);
  }
);
