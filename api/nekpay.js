import crypto from 'crypto';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Canonical signature: exclude BOTH `sign` and `sign_type` from the signed
 * set (the old version only excluded `sign`, which produced a signature
 * mismatch on every request/callback since NekPay's own signing excludes both).
 */
export function generateNekpaySignature(params, merchantKey = required('NEKPAYMENT_MERCHANT_KEY')) {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return crypto.createHash('md5')
    .update(`${canonical}&key=${merchantKey}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

export function verifyNekpaySignature(params) {
  const received = String(params.sign || '').toLowerCase();
  const expected = generateNekpaySignature(params);
  return Boolean(received) && received === expected;
}

/**
 * PAYOUT: Process an approved withdrawal.
 * Called only after internal admin approval. Sends a real transfer request
 * to NekPay's /pay/transfer endpoint.
 *
 * IMPORTANT: NekPay's synchronous response only confirms the transfer
 * REQUEST was accepted — tradeResult "0" means accepted/processing, not
 * paid. Only the withdrawal callback (verified separately) can confirm
 * final success ("1"), failure ("2"), rejection ("3"), or ongoing
 * processing ("4"). The caller (admin.js) must record this as PROCESSING,
 * never PAID, based on this function's result alone.
 */
export async function processNekpayPayout({ reference, net_amount, bank_code, account_number, account_name }) {
  if (!bank_code) {
    return { success: false, message: 'No bank_code on this payout account — cannot route transfer' };
  }

  const params = {
    mch_id: required('NEKPAYMENT_MCH_ID'),
    mch_transferId: reference,
    transfer_amount: Number(net_amount).toFixed(2),
    apply_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
    bank_code,
    receive_name: account_name,
    receive_account: account_number,
    back_url: required('NEKPAYMENT_WITHDRAW_NOTIFY_URL'),
    sign_type: 'MD5'
  };

  params.sign = generateNekpaySignature(params);

  const response = await fetch('https://api.nekpayment.com/pay/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });

  const result = await response.json();

  if (!response.ok || result.respCode !== 'SUCCESS') {
    return { success: false, message: result.errorMsg || 'NekPay transfer request failed' };
  }

  // tradeResult here is the SYNCHRONOUS acceptance status, not the final one.
  return {
    success: true,
    providerReference: result.tradeNo || result.merTransferId,
    status: String(result.tradeResult) === '1' ? 'paid' : 'processing',
    providerResponse: result
  };
}
