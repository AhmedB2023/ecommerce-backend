const express = require('express');
const Stripe = require('stripe');
const router = express.Router();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/create-checkout-session', async (req, res) => {
  const { cartItems } = req.body;

  const line_items = cartItems.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.name,
      },
      unit_amount: Math.round(parseFloat(item.price) * 100),
    },
    quantity: item.quantity || 1,
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: 'http://success_url: 'https://tajerr.netlify.app/thank-you',
cancel_url: 'https://tajerr.netlify.app/checkout',:3000/thank-you',
      cancel_url: 'http://success_url: 'https://tajerr.netlify.app/thank-you',
cancel_url: 'https://tajerr.netlify.app/checkout',:3000/checkout',
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
