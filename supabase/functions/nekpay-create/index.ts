// nekpay-create Edge Function Logic
Deno.serve(async (req) => {
  const { amount, reference, userId } = await req.json();
  
  // 1. Fetch Merchant Secrets from Env
  const MCH_ID = Deno.env.get('NEKPAYMENT_MCH_ID');
  const SECRET = Deno.env.get('NEKPAYMENT_MERCHANT_KEY');

  // 2. Build Nekpay Request Body
  const payload = {
    mch_id: MCH_ID,
    out_trade_no: reference,
    total_fee: amount * 100, // Nekpay usually uses kobo/cents
    body: "LAS VEGAS Wallet Deposit",
    notify_url: "https://your-api.com/nekpay-webhook",
    // ... other Nekpay required params
  };

  // 3. Call Nekpay API
  const response = await fetch('https://api.nekpayment.com/gateway/pay', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return new Response(JSON.stringify({ checkout_url: data.pay_url }), { status: 200 });
});
