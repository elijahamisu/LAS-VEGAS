import { createClient } from '@supabase/supabase-js';
import { verifyNekpaySignature } from '../lib/nekpay.js';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// NekPay calls this URL for two distinct events, distinguished by ?type=:
//   /api/webhook?type=deposit     (default if omitted, for back-compat)
//   /api/webhook?type=withdrawal
// Configure these as NEKPAYMENT_NOTIFY_URL and NEKPAYMENT_WITHDRAW_NOTIFY_URL respectively.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const type = req.query.type || 'deposit';
  const body = req.body;

  try {
    if (!verifyNekpaySignature(body)) {
      console.error('[WEBHOOK] Invalid signature from NekPay', { type });
      return res.status(400).send('fail');
    }

    if (type === 'withdrawal') {
      return await handleWithdrawalCallback(body, res);
    }
    return await handleDepositCallback(body, res);

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(500).send('fail');
  }
}

// ---------------------------------------------------------------------------
// DEPOSIT CALLBACK
// ---------------------------------------------------------------------------
async function handleDepositCallback(body, res) {
  const mchOrderNo = body.mchOrderNo;
  const orderNo = body.orderNo;
  // NekPay's actual callback field is `amount` — the old code read `tradeAmount`,
  // which doesn't exist on the callback payload and produced NaN.
  const amount = Number(body.amount ?? body.tradeAmount);

  if (!mchOrderNo || !orderNo || !Number.isFinite(amount) || amount <= 0) {
    console.error('[DEPOSIT WEBHOOK] Malformed callback payload', body);
    return res.status(400).send('fail');
  }

  if (String(body.tradeResult) === '1') {
    // This RPC must be idempotent: identify the pending deposit by `reference`
    // (= mchOrderNo), reject a mismatched amount, record NekPay's orderNo,
    // credit the wallet exactly once, and return success on a duplicate callback.
    const { data, error } = await supabase.rpc('process_nekpay_deposit', {
      p_mch_order_no: mchOrderNo,
      p_order_no: orderNo,
      p_amount: amount
    });
    if (error) throw error;
    if (data && data.success === false) {
      console.error('[DEPOSIT WEBHOOK] RPC rejected callback:', data.message);
      return res.status(400).send('fail');
    }
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('success');
}

// ---------------------------------------------------------------------------
// WITHDRAWAL CALLBACK
// Confirms (or fails) a transfer that admin.js already submitted and marked
// PROCESSING. Only this callback may set the final PAID/FAILED status.
// ---------------------------------------------------------------------------
async function handleWithdrawalCallback(body, res) {
  const { merTransferId, merNo, tradeNo, transferAmount, tradeResult } = body;

  if (!merTransferId || !Number.isFinite(Number(transferAmount))) {
    console.error('[WITHDRAWAL WEBHOOK] Malformed callback payload', body);
    return res.status(400).send('fail');
  }

  // tradeResult: "1" success, "2" failure, "3" rejected, "4" still processing
  const { data, error } = await supabase.rpc('process_nekpay_withdrawal_callback', {
    p_mer_transfer_id: merTransferId,
    p_mer_no: merNo,
    p_trade_no: tradeNo,
    p_amount: Number(transferAmount),
    p_trade_result: String(tradeResult)
  });

  if (error) throw error;
  if (data && data.success === false) {
    console.error('[WITHDRAWAL WEBHOOK] RPC rejected callback:', data.message);
    return res.status(400).send('fail');
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('success');
}
