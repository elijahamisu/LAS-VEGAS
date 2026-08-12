import crypto from 'crypto';

const MERCHANT_KEY = process.env.NEKPAY_MERCHANT_KEY;

export const NekPay = {
  /**
   * Generates the signature based on NekPay's documentation:
   * 1. Remove empty values.
   * 2. Sort keys by ASCII.
   * 3. Concatenate key=value.
   * 4. Append MERCHANT_KEY.
   * 5. MD5 and lowercase hex.
   */
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

// NOTE: admin.js originally imported `processNekpayPayout` from './nekpay.js',
// but that function's implementation was not present in the source files provided
// during the merge. It has been stubbed below so the app still runs — you MUST
// fill in the real NekPay disbursement/payout API call before using it in production.
export async function processNekpayPayout({ reference, net_amount, bank_code, account_number, account_name }) {
  // TODO: implement the real call to NekPay's payout/disbursement endpoint here,
  // following the same signature pattern as generateSignature() above.
  throw new Error('processNekpayPayout is not implemented — restore original logic before use');
}
