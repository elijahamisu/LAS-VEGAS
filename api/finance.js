import { createClient } from '@supabase/supabase-js';
import { createGloPaymentCollectionOrder } from '../lib/glopayment.js';
import { GLOPAYMENT_NGN_BANKS, isValidGloPaymentNgnBankCode } from '../lib/glopayment-ngn-banks.js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Was: investments.js + rewards.js + payments.js + withdrawals.js
// Route with ?resource=investments|rewards|payments|withdrawals&action=...
export default async function handler(req, res) {
  const { method, query, body } = req;
  const resource = query.resource;
  const action = query.action || body?.action;

  // Shared authentication guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Authentication required' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });
  const userId = user.id;

  try {
    switch (resource) {
      case 'investments':
        return await handleInvestments({ method, action, query, body, userId, res });
      case 'rewards':
        return await handleRewards({ method, action, query, body, userId, res });
      case 'payments':
        return await handlePayments({ method, action, body, userId, res });
      case 'withdrawals':
        return await handleWithdrawals({ method, action, query, body, userId, res });
      default:
        return res.status(400).json({ success: false, message: 'Invalid or missing resource' });
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}

// ---------------------------------------------------------------------------
// INVESTMENTS  (formerly investments.js)
// ---------------------------------------------------------------------------
async function handleInvestments({ method, action, query, body, userId, res }) {
  if (method === 'GET' && action === 'plans') {
    const { data, error } = await supabase
      .from('plans')
      .select('id, name, min_amount, daily_percent, duration_days, purchase_limit, is_active')
      .eq('is_active', true)
      .order('min_amount', { ascending: true });

    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (method === 'POST' && action === 'purchase') {
    const { plan_id, amount } = body;

    if (!plan_id || !amount || isNaN(amount) || amount <= 0) {
      throw new Error('Invalid plan ID or amount');
    }

    const { data, error } = await supabase.rpc('process_investment_purchase', {
      p_user_id: userId,
      p_plan_id: plan_id,
      p_amount: parseFloat(amount)
    });

    if (error) throw error;
    if (!data.success) throw new Error(data.message);

    return res.status(200).json({ success: true, message: data.message });
  }

  if (method === 'GET' && action === 'list') {
    const status = query.status || 'ACTIVE';
    const page = parseInt(query.page) || 0;
    const limit = 20;
    const from = page * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
      .from('investments')
      .select('*, plans(name)', { count: 'exact' })
      .eq('user_id', userId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return res.status(200).json({ success: true, data: { investments: data, total: count } });
  }

  if (method === 'GET' && action === 'details') {
    const { id } = query;
    if (!id) throw new Error('Investment ID required');

    const { data, error } = await supabase
      .from('investments')
      .select('*, plans(*)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new Error('Investment not found or access denied');
    return res.status(200).json({ success: true, data });
  }

  return res.status(400).json({ success: false, message: 'Invalid action' });
}

// ---------------------------------------------------------------------------
// REWARDS  (formerly rewards.js)
// ---------------------------------------------------------------------------
async function handleRewards({ method, action, query, body, userId, res }) {
  if (method === 'GET' && action === 'checkin-status') {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('daily_checkins')
      .select('id')
      .eq('user_id', userId)
      .eq('checkin_date', today)
      .maybeSingle();

    if (error) throw error;

    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['daily_checkin_reward', 'daily_task_active_date']);

    const settingsMap = (settingsRows || []).reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
    const reward = Number(settingsMap.daily_checkin_reward) || 50;
    const taskActiveToday = settingsMap.daily_task_active_date === today;

    return res.status(200).json({
      success: true,
      data: { checkedInToday: !!data, reward, taskActiveToday }
    });
  }

  // Joining the Telegram group/channel is the "task"; this credits the reward
  // once per day, but only while an admin has activated today's task.
  if (method === 'POST' && action === 'checkin') {
    const { data, error } = await supabase.rpc('claim_telegram_task');
    if (error) throw error;
    if (!data.success) throw new Error(data.message);
    return res.status(200).json({ success: true, message: `\u20a6${data.reward || 50} reward credited successfully`, data });
  }

  if (method === 'POST' && action === 'redeem-gift') {
    const { gift_code } = body;
    if (!gift_code) throw new Error('Gift code is required');

    const { data, error } = await supabase.rpc('redeem_gift_code', { p_code: gift_code });
    if (error) throw error;
    if (!data.success) throw new Error(data.message);
    return res.status(200).json({ success: true, message: `\u20a6${data.reward} reward credited`, data });
  }

  if (method === 'GET' && action === 'referral-summary') {
    const { data: profile } = await supabase.from('profiles').select('referral_code').eq('id', userId).single();

    const { data: commissions } = await supabase
      .from('referral_commissions')
      .select('commission_amount, level')
      .eq('user_id', userId);

    const stats = {
      l1_earned: commissions?.filter(c => c.level === 1).reduce((s, c) => s + Number(c.commission_amount), 0) || 0,
      l2_earned: commissions?.filter(c => c.level === 2).reduce((s, c) => s + Number(c.commission_amount), 0) || 0,
      referral_code: profile?.referral_code
    };

    return res.status(200).json({ success: true, data: stats });
  }

  if (method === 'GET' && action === 'referral-history') {
    const page = parseInt(query.page) || 0;
    const { data, error, count } = await supabase
      .from('referral_commissions')
      .select('id, level, commission_amount, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(page * 10, (page + 1) * 10 - 1);

    if (error) throw error;
    return res.status(200).json({ success: true, data: { history: data, total: count } });
  }

  return res.status(400).json({ success: false, message: 'Invalid reward action' });
}

// ---------------------------------------------------------------------------
// PAYMENTS  (formerly payments.js)
// NOTE: the original payments.js used `req.user.id` directly, which assumed
// an auth middleware that wasn't present in the source files. It has been
// updated here to use the same Supabase-token auth as every other resource
// in this file, so it now actually works standalone.
// ---------------------------------------------------------------------------
async function handlePayments({ method, action, body, userId, res }) {
  if (method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'submit-manual-deposit') {
    const rawAmount = String(body?.amount ?? '').trim();
    const bankName = String(body?.bank_name ?? '').trim();
    const accountName = String(body?.account_name ?? '').trim();

    if (!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Naira amount with at most two decimal places' });
    }
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 1000) {
      return res.status(400).json({ success: false, message: 'Minimum deposit is ₦1,000' });
    }
    if (!bankName || bankName.length > 120 || !accountName || accountName.length > 120) {
      return res.status(400).json({ success: false, message: 'Bank name and account name are required and must be 120 characters or fewer' });
    }

    const reference = `LVMAN${Date.now()}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
    const { error } = await supabase.from('deposits').insert({
      user_id: userId,
      reference,
      amount,
      status: 'PENDING',
      provider: 'manual',
      depositor_bank_name: bankName,
      depositor_account_name: accountName
    });

    if (error) {
      console.error('[MANUAL DEPOSIT DB ERROR]', error.message);
      return res.status(400).json({ success: false, message: 'Could not create the pending deposit record' });
    }

    await supabase.from('notifications').insert({
      user_id: userId,
      title: 'Manual Deposit Submitted',
      message: `Your manual deposit ${reference} is pending administrator approval.`,
      type: 'DEPOSIT'
    });

    return res.status(200).json({ success: true, reference, message: 'Deposit submitted for administrator approval' });
  }

  if (action !== 'initiate-deposit') {
    return res.status(400).json({ success: false, message: 'Invalid action' });
  }

  // Preserve the client decimal string until it is validated; do not use binary
  // floating-point arithmetic to decide what amount is submitted to the gateway.
  const rawAmount = String(body?.amount ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)) {
    return res.status(400).json({ success: false, message: 'Enter a valid Naira amount with at most two decimal places' });
  }
  const amountNumber = Number(rawAmount);
  if (!Number.isFinite(amountNumber) || amountNumber < 1000) {
    return res.status(400).json({ success: false, message: 'Minimum deposit is ₦1,000' });
  }
  const amount = amountNumber.toFixed(2);
  const reference = `LVGLO${Date.now()}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;

  // GloPayment requires customer details. Read them from the authenticated profile,
  // rather than trusting the browser to submit a name, email, or mobile number.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, email, phone_number')
    .eq('id', userId)
    .single();
  if (profileError || !profile) {
    return res.status(400).json({ success: false, message: 'Could not load your payment profile' });
  }

  const name = String(profile.full_name || '').trim();
  const email = String(profile.email || '').trim();
  const mobile = String(profile.phone_number || '').trim();
  if (!name || !email || !mobile) {
    return res.status(400).json({
      success: false,
      message: 'Complete your full name, email address, and phone number in Profile before depositing'
    });
  }

  // Persist before provider submission. The verified GloPayment callback later
  // settles the row through an idempotent Supabase database function.
  const { error: dbError } = await supabase.from('deposits').insert({
    user_id: userId,
    reference,
    amount: amountNumber,
    status: 'PENDING',
    provider: 'glopayment'
  });
  if (dbError) {
    console.error('[GLOPAYMENT DEPOSIT DB ERROR]', dbError.message);
    return res.status(400).json({ success: false, message: 'Could not create the pending deposit record' });
  }

  let orderResult;
  try {
    orderResult = await createGloPaymentCollectionOrder({
      orderId: reference,
      amount,
      name,
      email,
      mobile
    });
  } catch (providerError) {
    // A timeout/network failure is not proof that GloPayment rejected the order.
    // Preserve PENDING for reconciliation so a later callback can still be settled.
    console.error('[GLOPAYMENT ORDER REQUEST ERROR]', { reference, message: providerError.message });
    return res.status(502).json({
      success: false,
      reference,
      message: 'We could not confirm checkout creation. Do not retry if your bank was charged; contact support with this reference.'
    });
  }

  if (!orderResult.success) {
    if (orderResult.definitivelyRejected) {
      await supabase.from('deposits').update({ status: 'FAILED' }).eq('reference', reference);
    }
    console.error('[GLOPAYMENT ORDER NOT CONFIRMED]', {
      reference,
      definitivelyRejected: orderResult.definitivelyRejected,
      httpStatus: orderResult.httpStatus,
      providerResponse: orderResult.providerResponse
    });
    return res.status(orderResult.definitivelyRejected ? 400 : 502).json({
      success: false,
      reference,
      message: orderResult.definitivelyRejected
        ? 'The payment provider rejected checkout creation.'
        : 'We could not confirm checkout creation. Do not retry if your bank was charged; contact support with this reference.'
    });
  }

  // This only starts hosted checkout. Wallet credit comes exclusively from a
  // verified callback whose returnCode is "00".
  return res.status(200).json({ success: true, payInfo: orderResult.checkoutUrl, reference });
}


// ---------------------------------------------------------------------------
// WITHDRAWALS  (restored — user-initiated withdrawal request + payout accounts)
// Bank codes come from GloPayment's Nigeria list (800...), NOT the old NekPay
// list (NGR...) — those are not interchangeable. Admin approval/payout still
// lives in admin.js (resource=admin) as a manual mark-paid step, not an
// automated provider call, per GLOPAYMENT/WITHDRAWAL.js.
// ---------------------------------------------------------------------------
async function handleWithdrawals({ method, action, query, body, userId, res }) {
  if (method === 'GET' && action === 'accounts') {
    const { data, error } = await supabase
      .from('withdrawal_accounts')
      .select('id, bank_code, bank_name, provider_name, account_number, account_name, is_default')
      .eq('user_id', userId)
      .order('is_default', { ascending: false });
    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (method === 'GET' && action === 'bank-list') {
    return res.status(200).json({ success: true, data: GLOPAYMENT_NGN_BANKS });
  }

  if (method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'add-account') {
    const { bank_code, account_number, account_name, is_default } = body;

    if (!isValidGloPaymentNgnBankCode(bank_code)) {
      throw new Error('Select a valid bank from the list');
    }
    if (!account_number || !account_name) throw new Error('Account number and account name are required');

    if (is_default) {
      await supabase.from('withdrawal_accounts').update({ is_default: false }).eq('user_id', userId);
    }

    const bankMeta = GLOPAYMENT_NGN_BANKS.find(b => b.code === bank_code);
    const { data, error } = await supabase.from('withdrawal_accounts').insert({
      user_id: userId,
      bank_code,
      bank_name: bankMeta.name,
      provider_name: bankMeta.name,
      account_number,
      account_name,
      is_default: !!is_default
    }).select().single();

    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (action === 'withdraw') {
    const { amount, payout_account_id } = body;

    if (!amount || isNaN(amount) || amount <= 0) throw new Error('Invalid withdrawal amount');
    if (!payout_account_id) throw new Error('Payout account is required');

    const { data: account, error: acctErr } = await supabase
      .from('withdrawal_accounts')
      .select('bank_code')
      .eq('id', payout_account_id)
      .eq('user_id', userId)
      .single();

    if (acctErr || !account) throw new Error('Payout account not found');
    if (!isValidGloPaymentNgnBankCode(account.bank_code)) {
      throw new Error('This payout account has an outdated bank code — please re-add it');
    }

    const { data, error } = await supabase.rpc('request_withdrawal_v2', {
      p_user_id: userId,
      p_amount: parseFloat(amount),
      p_account_id: payout_account_id
    });
    if (error || !data.success) throw new Error(error?.message || data?.message || 'Withdrawal failed');

    await supabase.from('notifications').insert({
      user_id: userId,
      title: "Withdrawal Pending",
      message: `Your request for \u20a6${amount} is pending admin review.`,
      type: "WITHDRAWAL"
    });

    return res.status(200).json({ success: true, message: 'Request submitted' });
  }

  return res.status(400).json({ success: false, message: 'Invalid action' });
}
