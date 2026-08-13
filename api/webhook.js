import { createClient } from '@supabase/supabase-js';
import { verifyNekpaySignature } from '../lib/nekpay.js';
import { getGloPaymentConfig, verifyGloPaymentSignature } from '../lib/glopayment.js';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Register these provider callback addresses:
// - GloPayment deposit:     https://YOUR-DOMAIN/api/webhook?type=glopay
// - GloPayment withdrawal:  https://YOUR-DOMAIN/api/webhook?type=glopay-withdrawal
// - NekPay deposit:         https://YOUR-DOMAIN/api/webhook?type=deposit
// - NekPay withdrawal:      https://YOUR-DOMAIN/api/webhook?type=withdrawal
// GloPayment expects the literal lowercase acknowledgement body `ok`.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const type = String(req.query.type || 'deposit').toLowerCase();
  const body = req.body;

  try {
    if (type === 'glopay') {
      if (!verifyGloPaymentSignature(body)) {
        console.error('[GLOPAYMENT DEPOSIT WEBHOOK] Invalid signature');
        return res.status(400).send('fail');
      }
      return await handleGloPaymentDepositCallback(body, res);
    }

    if (type === 'glopay-withdrawal') {
      const paymentKey = process.env.GLOPAYMENT_PAYMENT_KEY;
      if (!paymentKey || !verifyGloPaymentSignature(body, paymentKey)) {
        console.error('[GLOPAYMENT WITHDRAWAL WEBHOOK] Invalid signature');
        return res.status(400).send('fail');
      }
      return await handleGloPaymentWithdrawalCallback(body, res);
    }

    // Preserve the NekPay routes for historical or in-flight NekPay records.
    if (!verifyNekpaySignature(body)) {
      console.error('[NEKPAY WEBHOOK] Invalid signature', { type });
      return res.status(400).send('fail');
    }
    if (type === 'withdrawal') {
      return await handleNekpayWithdrawalCallback(body, res);
    }
    return await handleNekpayDepositCallback(body, res);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    return res.status(500).send('fail');
  }
}

// ---------------------------------------------------------------------------
// GLOPAYMENT DEPOSIT CALLBACK
// Expected JSON: orderId, merchantId, merchantOrderId, amount, dateTime,
// returnCode, sign. Only returnCode "00" can credit a wallet.
// ---------------------------------------------------------------------------
async function handleGloPaymentDepositCallback(body, res) {
  const requiredFields = [
    'orderId',
    'merchantId',
    'merchantOrderId',
    'amount',
    'dateTime',
    'returnCode',
    'sign'
  ];

  for (const field of requiredFields) {
    if (typeof body?.[field] !== 'string' || body[field].trim() === '') {
      console.error('[GLOPAYMENT DEPOSIT WEBHOOK] Missing required field', field);
      return res.status(400).send('fail');
    }
  }

  const { merchantId, merchantOrderId, orderId, amount, returnCode } = body;
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('fail');
  }

  const config = getGloPaymentConfig();
  if (merchantId !== config.merchantId) {
    console.error('[GLOPAYMENT DEPOSIT WEBHOOK] Merchant mismatch', { merchantOrderId });
    return res.status(400).send('fail');
  }

  // The SQL RPC locks the pending deposit, verifies provider/amount/order,
  // writes a single wallet credit for returnCode "00", and records failure
  // for all other return codes. It is idempotent for callback retries.
  const { data, error } = await supabase.rpc('process_glopayment_deposit', {
    p_merchant_order_id: merchantOrderId,
    p_provider_order_id: orderId,
    p_merchant_id: merchantId,
    p_amount: amountNumber,
    p_return_code: returnCode,
    p_callback: body
  });

  if (error) throw error;
  if (data && data.success === false) {
    console.error('[GLOPAYMENT DEPOSIT WEBHOOK] RPC rejected callback:', data.message);
    return res.status(400).send('fail');
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('ok');
}

// ---------------------------------------------------------------------------
// GLOPAYMENT WITHDRAWAL CALLBACK
// GloPayment signs this payload with the separate Payment Key. A synchronous
// payout response is only acceptance; callback returnCode "00" marks PAID.
// ---------------------------------------------------------------------------
async function handleGloPaymentWithdrawalCallback(body, res) {
  const requiredFields = [
    'orderId',
    'merchantId',
    'merchantOrderId',
    'amount',
    'dateTime',
    'returnCode',
    'sign'
  ];

  for (const field of requiredFields) {
    if (typeof body?.[field] !== 'string' || body[field].trim() === '') {
      return res.status(400).send('fail');
    }
  }

  const { merchantId, merchantOrderId, orderId, amount, returnCode } = body;
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return res.status(400).send('fail');
  }

  const config = getGloPaymentConfig();
  if (merchantId !== config.merchantId) {
    console.error('[GLOPAYMENT WITHDRAWAL WEBHOOK] Merchant mismatch', { merchantOrderId });
    return res.status(400).send('fail');
  }

  const { data, error } = await supabase.rpc('process_glopayment_withdrawal_callback', {
    p_merchant_order_id: merchantOrderId,
    p_provider_order_id: orderId,
    p_merchant_id: merchantId,
    p_amount: amountNumber,
    p_return_code: returnCode,
    p_callback: body
  });

  if (error) throw error;
  if (data && data.success === false) {
    console.error('[GLOPAYMENT WITHDRAWAL WEBHOOK] RPC rejected callback:', data.message);
    return res.status(400).send('fail');
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('ok');
}

// ---------------------------------------------------------------------------
// NEKPAY DEPOSIT CALLBACK (preserved for historical/in-flight NekPay orders)
// ---------------------------------------------------------------------------
async function handleNekpayDepositCallback(body, res) {
  const mchOrderNo = body.mchOrderNo;
  const orderNo = body.orderNo;
  const amount = Number(body.amount ?? body.tradeAmount);

  if (!mchOrderNo || !orderNo || !Number.isFinite(amount) || amount <= 0) {
    console.error('[NEKPAY DEPOSIT WEBHOOK] Malformed callback payload', body);
    return res.status(400).send('fail');
  }

  if (String(body.tradeResult) === '1') {
    const { data, error } = await supabase.rpc('process_nekpay_deposit', {
      p_mch_order_no: mchOrderNo,
      p_order_no: orderNo,
      p_amount: amount
    });
    if (error) throw error;
    if (data && data.success === false) {
      console.error('[NEKPAY DEPOSIT WEBHOOK] RPC rejected callback:', data.message);
      return res.status(400).send('fail');
    }
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('success');
}

// ---------------------------------------------------------------------------
// NEKPAY WITHDRAWAL CALLBACK (unchanged)
// ---------------------------------------------------------------------------
async function handleNekpayWithdrawalCallback(body, res) {
  const { merTransferId, merNo, tradeNo, transferAmount, tradeResult } = body;

  if (!merTransferId || !Number.isFinite(Number(transferAmount))) {
    console.error('[NEKPAY WITHDRAWAL WEBHOOK] Malformed callback payload', body);
    return res.status(400).send('fail');
  }

  const { data, error } = await supabase.rpc('process_nekpay_withdrawal_callback', {
    p_mer_transfer_id: merTransferId,
    p_mer_no: merNo,
    p_trade_no: tradeNo,
    p_amount: Number(transferAmount),
    p_trade_result: String(tradeResult)
  });

  if (error) throw error;
  if (data && data.success === false) {
    console.error('[NEKPAY WITHDRAWAL WEBHOOK] RPC rejected callback:', data.message);
    return res.status(400).send('fail');
  }

  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('success');
}
