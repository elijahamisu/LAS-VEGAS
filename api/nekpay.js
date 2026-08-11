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
