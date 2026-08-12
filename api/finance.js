import { createClient } from '@supabase/supabase-js';
import { NekPay } from '../lib/nekpay.js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Was: investments.js + rewards.js + payments.js
// Route with ?resource=investments|rewards|payments&action=...
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
        return await handleWithdrawals({ method, action, body, userId, res });
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
    return res.status(200).json({
      success: true,
      data: { checkedInToday: !!data, reward: 200 }
    });
  }

  if (method === 'POST' && action === 'checkin') {
    const { data, error } = await supabase.rpc('claim_daily_checkin');
    if (error) throw error;
    if (!data.success) throw new Error(data.message);
    return res.status(200).json({ success: true, message: '\u20a6200 reward credited successfully', data });
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

  if (action === 'initiate-deposit') {
    const { amount } = body;
    const mchOrderNo = `LV${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const orderDate = new Date().toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:mm:ss

    // Create record in Supabase first
    const { error: dbErr } = await supabase.from('deposits').insert({
      user_id: userId,
      mch_order_no: mchOrderNo,
      amount: parseFloat(amount),
      status: 'PENDING',
      provider: 'nekpay'
    });
    if (dbErr) {
      console.error('[DEPOSIT DB ERROR]:', dbErr.message);
      return res.status(400).json({ success: false, message: `DB Error: ${dbErr.message}` });
    }

    const params = {
      version: "1.0",
      mch_id: process.env.NEKPAY_MCH_ID,
      notify_url: process.env.NEKPAY_NOTIFY_URL,
      page_url: process.env.NEKPAY_RETURN_URL,
      mch_order_no: mchOrderNo,
      pay_type: process.env.NEKPAY_PAY_TYPE || "122",
      trade_amount: parseFloat(amount).toFixed(2),
      order_date: orderDate,
      bank_code: "",
      goods_name: "Wallet Topup",
      sign_type: "MD5"
    };

    params.sign = NekPay.generateSignature(params);

    // Call NekPay
    const nekRes = await fetch('https://api.nekpayment.com/pay/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });

    const result = await nekRes.json();
    if (result.respCode === "SUCCESS" && result.tradeResult === "1") {
      return res.status(200).json({ success: true, payInfo: result.payInfo });
    }
    return res.status(400).json({ success: false, message: result.tradeMsg });
  }

  return res.status(400).json({ success: false, message: 'Invalid action' });
}

// ---------------------------------------------------------------------------
// WITHDRAWALS  (new — user-initiated withdrawal request)
// Approval, rejection, and payout still live in admin.js (resource=admin),
// this is just the user-facing "submit a request" step.
// ---------------------------------------------------------------------------
async function handleWithdrawals({ method, action, body, userId, res }) {
  if (method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'withdraw') {
    const { amount, payout_account_id } = body;

    if (!amount || isNaN(amount) || amount <= 0) throw new Error('Invalid withdrawal amount');
    if (!payout_account_id) throw new Error('Payout account is required');

    const { data, error } = await supabase.rpc('request_withdrawal_v2', {
      p_user_id: userId,
      p_amount: parseFloat(amount),
      p_account_id: payout_account_id
    });
    if (error || !data.success) throw new Error(error?.message || data?.message || 'Withdrawal failed');

    // Trigger internal notification
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
