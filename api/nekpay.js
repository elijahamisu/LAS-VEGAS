import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Server-side Secrets
const MCH_ID = process.env.NEKPAY_MERCHANT_ID;
const SECRET = process.env.NEKPAY_SECRET;
const BASE_URL = process.env.NEKPAY_BASE_URL || 'https://api.nekpayment.com/gateway';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * INTERNAL HELPER: Sign Request
 * Sorts keys alphabetically and appends the merchant secret for MD5/HMAC verification
 */
function generateSignature(params) {
  const sortedKeys = Object.keys(params).sort();
  let str = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  str += `&key=${SECRET}`;
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase();
}

/**
 * DEPOSIT: Initiate Payment
 * Called by api/payments.js
 */
export async function createNekpayPayment({ amount, reference, email }) {
  const params = {
    mch_id: MCH_ID,
    out_trade_no: reference,
    total_fee: Math.round(amount * 100), // NekPay uses kobo/cents
    body: "LAS VEGAS Wallet Deposit",
    notify_url: process.env.NEKPAY_NOTIFY_URL,
    nonce_str: crypto.randomBytes(16).toString('hex')
  };
  
  params.sign = generateSignature(params);

  const res = await fetch(`${BASE_URL}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await res.json();
  if (data.return_code !== 'SUCCESS') throw new Error(data.return_msg || 'Payment initialization failed');
  
  return { url: data.pay_url, providerReference: data.prepay_id };
}

/**
 * PAYOUT: Process Approved Withdrawal
 * Only called after internal Admin Approval
 */
export async function processNekpayPayout(withdrawalRecord) {
  const params = {
    mch_id: MCH_ID,
    out_trade_no: withdrawalRecord.reference,
    amount: Math.round(withdrawalRecord.net_amount * 100),
    bank_code: withdrawalRecord.bank_code,
    account_no: withdrawalRecord.account_number,
    account_name: withdrawalRecord.account_name,
    nonce_str: crypto.randomBytes(16).toString('hex')
  };

  params.sign = generateSignature(params);

  const res = await fetch(`${BASE_URL}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await res.json();
  return {
    success: data.return_code === 'SUCCESS',
    providerReference: data.payment_no,
    message: data.return_msg
  };
}

/**
 * VERCEL SERVERLESS HANDLER
 */
export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Auth & Admin Check
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Auth required' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });

  try {
    // 2. Action: Check Merchant Balance (Admin Only)
    if (action === 'merchant-balance') {
      const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
      if (!profile?.is_admin) return res.status(403).json({ success: false, message: 'Forbidden' });

      const params = { mch_id: MCH_ID, nonce_str: crypto.randomBytes(16).toString('hex') };
      params.sign = generateSignature(params);

      const response = await fetch(`${BASE_URL}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      const data = await response.json();
      return res.status(200).json({ success: true, data: { balance: data.balance / 100 } });
    }

    // 3. Action: Query Specific Transaction Status
    if (action === 'query-status') {
      const { reference } = query;
      const params = { mch_id: MCH_ID, out_trade_no: reference, nonce_str: crypto.randomBytes(16).toString('hex') };
      params.sign = generateSignature(params);

      const response = await fetch(`${BASE_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      const data = await response.json();
      return res.status(200).json({ success: true, status: data.trade_state });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Gateway communication error' });
  }
}
