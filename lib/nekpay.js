import crypto from 'crypto';

const MERCHANT_KEY = process.env.NEKPAY_MERCHANT_KEY;

export const NekPay = {
  generateSignature(params) {
    const sortedKeys = Object.keys(params)
      .filter(k => params[k] !== "" && params[k] !== null && params[k] !== undefined && k !== 'sign')
      .sort();

    const signString = sortedKeys
      .map(k => `${k}=${params[k]}`)
      .join('&') + `&key=${MERCHANT_KEY}`;

    return crypto.createHash('md5').update(signString).digest('hex').toLowerCase();
  },

  verifyNotification(body) {
    const receivedSign = body.sign;
    const calculatedSign = this.generateSignature(body);
    return receivedSign === calculatedSign;
  }
};

// TODO: implement the real call to NekPay's payout/disbursement endpoint here.
// This is only used by the withdrawal payout flow, not the balance-adjust
// feature you're testing — it's stubbed so the file still exports something.
export async function processNekpayPayout({ reference, net_amount, bank_code, account_number, account_name }) {
  throw new Error('processNekpayPayout is not implemented — restore original logic before use');
}
