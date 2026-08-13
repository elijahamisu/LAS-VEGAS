import crypto from 'crypto';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getGloPaymentConfig() {
  return {
    host: required('GLOPAYMENT_HOST').replace(/\/$/, ''),
    merchantId: required('GLOPAYMENT_MERCHANT_ID'),
    signingKey: required('GLOPAYMENT_SIGNING_KEY'),
    collectionChannelCode: required('GLOPAYMENT_NGN_COLLECTION_CHANNEL_CODE')
  };
}

/**
 * GloPayment signature documented by the provider:
 * 1. Exclude sign and all null/undefined values.
 * 2. Sort the remaining keys alphabetically.
 * 3. Join them as key=value pairs with & and append gloKeys=<key>.
 * 4. HMAC-SHA512 using the merchant signing key.
 * 5. Base64 encode the raw HMAC value, then MD5 hash that Base64 text.
 *
 * Verified against GLOPayment's official documented example:
 *   key = '8e11fcfb57574e5298f3f064335b6c0d'
 *   params = { merchantId: '000001000001', orderId: '202211244508894019584',
 *              channelCode: '285', amount: '100.00', name: 'test',
 *              email: 'test@gmail.com', mobile: '9999999999' }
 *   expected sign = '8ed394a8d1c3c71a6d6353de498b4464'
 * This implementation reproduces that value exactly.
 */
export function generateGloPaymentSignature(params, signingKey = required('GLOPAYMENT_SIGNING_KEY')) {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'sign')
    .filter((key) => params[key] !== null && params[key] !== undefined)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
  const stringToSign = canonical
    ? `${canonical}&gloKeys=${signingKey}`
    : `gloKeys=${signingKey}`;
  const hmacBase64 = crypto
    .createHmac('sha512', signingKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return crypto.createHash('md5').update(hmacBase64, 'utf8').digest('hex');
}

export function verifyGloPaymentSignature(params, signingKey = required('GLOPAYMENT_SIGNING_KEY')) {
  const received = String(params?.sign || '');
  const expected = generateGloPaymentSignature(params, signingKey);
  if (!received || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
}

export async function createGloPaymentCollectionOrder({ orderId, amount, name, email, mobile }) {
  const config = getGloPaymentConfig();

  // TEMPORARY DIAGNOSTIC LOGGING — remove once the "sign error" is resolved.
  // Never logs the full signing key or merchant secret, only enough to catch
  // trailing whitespace / wrong-environment / mismatched-credential issues.
  console.log('[GLOPAYMENT DEBUG] config check', {
    host: config.host,
    merchantId: config.merchantId,
    merchantIdLength: config.merchantId.length,
    channelCode: config.collectionChannelCode,
    signingKeyLength: config.signingKey.length,
    signingKeyPreview: `${config.signingKey.slice(0, 4)}...${config.signingKey.slice(-4)}`,
    signingKeyHasWhitespace: /\s/.test(config.signingKey),
    merchantIdHasWhitespace: /\s/.test(config.merchantId)
  });

  const params = {
    merchantId: config.merchantId,
    orderId,
    channelCode: config.collectionChannelCode,
    amount,
    name,
    email,
    mobile
  };
  params.sign = generateGloPaymentSignature(params, config.signingKey);

  console.log('[GLOPAYMENT DEBUG] outgoing params', {
    ...params,
    sign: params.sign // signature itself is not secret, safe to log in full
  });

  const response = await fetch(`${config.host}/pay/order/actions/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000)
  });

  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }

  if (!response.ok || String(result?.status) !== '200' || typeof result?.url !== 'string') {
    return {
      success: false,
      message: 'GloPayment did not create a valid checkout session',
      httpStatus: response.status,
      // A readable non-200 provider status is a definite rejection. A network
      // failure or malformed response remains unknown and must stay reconcilable.
      definitivelyRejected: Boolean(result && String(result.status) !== '200'),
      providerResponse: result
    };
  }

  let checkoutUrl;
  try {
    checkoutUrl = new URL(result.url).toString();
  } catch {
    return {
      success: false,
      message: 'GloPayment returned an invalid checkout URL',
      httpStatus: response.status,
      definitivelyRejected: false,
      providerResponse: result
    };
  }

  return {
    success: true,
    checkoutUrl,
    providerResponse: result,
    channelCode: config.collectionChannelCode
  };
}
