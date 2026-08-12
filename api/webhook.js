import { createClient } from '@supabase/supabase-js';
import { NekPay } from '../lib/nekpay.js';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const data = req.body;

  try {
    // 1. Verify Signature
    if (!NekPay.verifyNotification(data)) {
      console.error('[WEBHOOK] Invalid signature from NekPay');
      return res.status(400).send('fail');
    }

    // 2. Identify the transaction
    const { mchOrderNo, orderNo, tradeResult, tradeAmount } = data;
    const amount = parseFloat(tradeAmount);

    // 3. Trade Result Check (1 = Success)
    if (tradeResult === "1") {
      // 4. ATOMIC DATABASE TRANSACTION (via RPC)
      // This RPC ensures: status='completed', balance+=amount, transaction recorded.
      // It also prevents duplicate processing using 'gateway_order_no' unique constraint.
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('process_nekpay_deposit', {
        p_mch_order_no: mchOrderNo,
        p_order_no: orderNo,
        p_amount: amount
      });

      if (rpcErr) throw rpcErr;
    }

    // 5. NekPay Acknowledgement
    return res.status(200).send('success');

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(500).send('fail');
  }
}
