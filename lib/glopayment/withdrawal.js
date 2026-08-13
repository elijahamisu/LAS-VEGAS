import { generateGloPaymentSignature } from './glopayment.js';
import { isValidGloPaymentNgnBankCode } from './glopayment-ngn-banks.js';

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredEnv(name) {
  return required(process.env[name], name);
}

/**
 * GloPayment documents a mandatory generic payout field named `number`, but the
 * public Nigeria documentation does not state its meaning. This explicit mapping
 * gate prevents a payout until GloPayment has confirmed the right interpretation.
 */
export function resolveGloPaymentPayoutNumber({ accountNumber, mobile }) {
  const mode = String(process.env.GLOPAYMENT_NGN_PAYOUT_NUMBER_MODE || '').trim().toLowerCase();
  if (mode === 'account_number') return required(accountNumber, 'accountNumber');
  if (mode === 'mobile') return required(mobile, 'recipient mobile number');
  if (mode === 'static') return requiredEnv('GLOPAYMENT_NGN_PAYOUT_NUMBER');
  throw new Error(
    'Set GLOPAYMENT_NGN_PAYOUT_NUMBER_MODE after GloPayment confirms the required Nigeria payout `number` field'
  );
}

export function buildGloPaymentPayoutRequest({
  merchantOrderId,
  amount,
  beneficiaryName,
  accountNumber,
  bankCode,
  beneficiaryEmail,
  beneficiaryMobile
}) {
  const host = requiredEnv('GLOPAYMENT_HOST').replace(/\/$/, '');
  const merchantId = requiredEnv('GLOPAYMENT_MERCHANT_ID');
  const paymentKey = requiredEnv('GLOPAYMENT_PAYMENT_KEY');
  const channelCode = requiredEnv('GLOPAYMENT_NGN_PAYOUT_CHANNEL_CODE');

  if (channelCode !== '506') {
    throw new Error('GLOPAYMENT_NGN_PAYOUT_CHANNEL_CODE must be 506 for the enabled Nigeria Category I Payment channel');
  }
  if (!isValidGloPaymentNgnBankCode(bankCode)) {
    throw new Error('This payout account does not have a valid GloPayment Nigeria bank code. Re-add the account using the updated bank list.');
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(amount))) {
    throw new Error('Payout amount must be a positive Naira value with at most two decimal places');
  }
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    throw new Error('Payout amount must be greater than zero');
  }

  const payload = {
    merchantId,
    orderId: required(merchantOrderId, 'merchantOrderId'),
    channelCode,
    amount: amountNumber.toFixed(2),
    name: required(beneficiaryName, 'beneficiaryName'),
    account: required(accountNumber, 'accountNumber'),
    bankCode: String(bankCode),
    number: resolveGloPaymentPayoutNumber({ accountNumber, mobile: beneficiaryMobile }),
    email: required(beneficiaryEmail, 'beneficiaryEmail'),
    mobile: required(beneficiaryMobile, 'beneficiaryMobile')
  };
  payload.sign = generateGloPaymentSignature(payload, paymentKey);

  return {
    url: `${host}/payment/order/actions/commit`,
    payload
  };
}

/**
 * Sends an administrator-approved payout. An accepted synchronous response is
 * still only a submission acknowledgement: callback processing decides PAID.
 */
export async function processGloPaymentPayout(input) {
  const { url, payload } = buildGloPaymentPayoutRequest(input);
  let response;
  let providerResponse;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload),
      signal: AbortSignal.timeout(20_000)
    });
    try {
      providerResponse = await response.json();
    } catch {
      providerResponse = null;
    }
  } catch (error) {
    return {
      success: false,
      definitiveRejection: false,
      message: 'Could not confirm the GloPayment payout request. Keep this withdrawal in PROCESSING and reconcile it before any retry.',
      providerResponse: null,
      error: error.message
    };
  }

  const accepted = response.ok && String(providerResponse?.status) === '200';
  if (!accepted) {
    return {
      success: false,
      definitiveRejection: Boolean(providerResponse && String(providerResponse.status) !== '200'),
      message: providerResponse?.message || providerResponse?.msg || 'GloPayment rejected the payout request',
      httpStatus: response.status,
      providerResponse
    };
  }

  return {
    success: true,
    status: 'processing',
    providerReference: providerResponse?.orderId || providerResponse?.merchantOrderId || payload.orderId,
    providerResponse
  };
}
