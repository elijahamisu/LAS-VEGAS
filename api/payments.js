import { createClient } from '@supabase/supabase-js';
import { NekPay } from './nekpay.js';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { action, amount } = req.body;
  // Authenticate user via Supabase ...
  const userId = req.user.id; 

  if (action === 'initiate-deposit') {
    const mchOrderNo = `LV${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const orderDate = new Date().toISOString().slice(0,19).replace('T', ' '); // YYYY-MM-DD HH:mm:ss

    // Create record in Supabase first
    const { error: dbErr } = await supabase.from('deposits').insert({
      user_id: userId,
      mch_order_no: mchOrderNo,
      amount: parseFloat(amount),
      status: 'pending',
      provider: 'nekpay'
    });
    if (dbErr) return res.status(400).json({ success: false, message: 'DB Error' });

    const params = {
      version: "1.0",
      mch_id: process.env.NEKPAY_MCH_ID,
      notify_url: process.env.NEKPAY_NOTIFY_URL,
      page_url: process.env.NEKPAY_RETURN_URL,
      mch_order_no: mchOrderNo,
      pay_type: process.env.NEKPAY_PAY_TYPE || "122",
      trade_amount: parseFloat(amount).toFixed(2),
      order_date: orderDate,
      bank_code: "",
      goods_name: "Wallet Topup",
      sign_type: "MD5"
    };

    params.sign = NekPay.generateSignature(params);

    // Call NekPay
    const nekRes = await fetch('https://api.nekpayment.com/pay/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });

    const result = await nekRes.json();
    if (result.respCode === "SUCCESS" && result.tradeResult === "1") {
      return res.status(200).json({ success: true, payInfo: result.payInfo });
    }
    return res.status(400).json({ success: false, message: result.tradeMsg });
  }
}
