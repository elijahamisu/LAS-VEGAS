import { createClient } from '@supabase/supabase-js';
import { processNekpayPayout } from '../lib/nekpay.js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Was: admin.js + reports.js + settings.js
// Route with ?resource=admin|reports|settings&action=...
// NOTE: settings resource has a public sub-action ('public') that does NOT
// require auth — that check happens first, before the admin guard below.
export default async function handler(req, res) {
  const { method, query, body } = req;
  const resource = query.resource;
  const action = query.action || body?.action;

  // Settings has one public, unauthenticated action — handle before the admin guard
  if (resource === 'settings' && method === 'GET' && action === 'public') {
    return await handlePublicSettings(res);
  }

  // Everything else in this file requires an authenticated admin
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return res.status(403).json({ success: false, message: 'Access Denied: Admin role required' });

  try {
    switch (resource) {
      case 'admin':
        return await handleAdmin({ method, action, query, body, adminId: user.id, res });
      case 'reports':
        return await handleReports({ method, action, query, res });
      case 'settings':
        return await handleAdminSettings({ method, action, body, adminId: user.id, res });
      default:
        return res.status(400).json({ success: false, message: 'Invalid or missing resource' });
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}

// ---------------------------------------------------------------------------
// ADMIN  (formerly admin.js)
// ---------------------------------------------------------------------------
async function handleAdmin({ method, action, query, body, adminId, res }) {
  if (method === 'GET') {
    if (action === 'dashboard') {
      const [{ count: uCount }, { count: depCount }, { count: wCount }, { data: balances }] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('deposits').select('*', { count: 'exact', head: true }).eq('status', 'SUCCESSFUL'),
        supabase.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'PENDING'),
        supabase.from('wallets').select('balance')
      ]);
      const totalLiability = balances.reduce((s, x) => s + Number(x.balance), 0);
      return res.status(200).json({ success: true, data: { users: uCount, pending_withdrawals: wCount, liability: totalLiability } });
    }

    if (action === 'users') {
      const page = parseInt(query.page) || 0;
      const { data, count } = await supabase.from('profiles').select('*, wallets(balance)', { count: 'exact' })
        .order('created_at', { ascending: false }).range(page * 20, (page + 1) * 20 - 1);
      return res.status(200).json({ success: true, data: { list: data, total: count } });
    }

    if (action === 'user-details') {
      const { id } = query;
      const [{ data: p }, { data: w }, { data: inv }] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', id).single(),
        supabase.from('wallets').select('*').eq('user_id', id).single(),
        supabase.from('investments').select('*, plans(name)').eq('user_id', id)
      ]);
      return res.status(200).json({ success: true, data: { profile: p, wallet: w, investments: inv } });
    }

    if (action === 'settings') {
      const { data } = await supabase.from('settings').select('*');
      return res.status(200).json({ success: true, data });
    }
  }

  if (method === 'POST') {
    if (action === 'approve-withdrawal') {
      const { id } = body;
      const { data, error } = await supabase.rpc('admin_approve_withdrawal', { p_admin_id: adminId, p_withdrawal_id: id });
      if (error || !data.success) throw new Error(data?.message || 'Approval failed');
      return res.status(200).json({ success: true, message: 'Withdrawal approved. Ready for payout.' });
    }

    if (action === 'reject-withdrawal') {
      const { id, reason } = body;
      const { data, error } = await supabase.rpc('admin_reject_withdrawal', { p_admin_id: adminId, p_withdrawal_id: id, p_reason: reason });
      if (error || !data.success) throw new Error(data?.message || 'Rejection failed');
      return res.status(200).json({ success: true, message: 'Withdrawal rejected and funds released.' });
    }

    if (action === 'payout-withdrawal') {
      const { id } = body;
      const { data: wd } = await supabase.from('withdrawals').select('*, withdrawal_accounts(*)').eq('id', id).single();
      if (wd.status !== 'APPROVED') throw new Error('Disbursement requires previous admin approval');

      await supabase.from('withdrawals').update({ status: 'PROCESSING' }).eq('id', id);

      const payout = await processNekpayPayout({
        reference: wd.reference,
        net_amount: wd.net_amount,
        bank_code: wd.withdrawal_accounts.bank_code,
        account_number: wd.withdrawal_accounts.account_number,
        account_name: wd.withdrawal_accounts.account_name
      });

      if (payout.success) {
        await supabase.from('withdrawals').update({ status: 'PAID', payout_reference: payout.providerReference, processed_at: new Date().toISOString() }).eq('id', id);
        return res.status(200).json({ success: true, message: 'Funds disbursed via NekPay' });
      } else {
        await supabase.from('withdrawals').update({ status: 'FAILED' }).eq('id', id);
        throw new Error(payout.message);
      }
    }

    if (action === 'update-settings') {
      const { updates } = body;
      const { error } = await supabase.from('settings').upsert(updates);
      if (error) throw error;
      await supabase.from('admin_audit_logs').insert({ admin_id: adminId, action: 'SETTINGS_UPDATE', details: updates });
      return res.status(200).json({ success: true, message: 'Settings updated' });
    }
  }

  return res.status(400).json({ success: false, message: 'Invalid admin action' });
}

// ---------------------------------------------------------------------------
// REPORTS  (formerly reports.js) — read-only
// ---------------------------------------------------------------------------
async function handleReports({ method, action, query, res }) {
  const fromDate = query.from || new Date(new Date().setDate(new Date().getDate() - 30)).toISOString();
  const toDate = query.to || new Date().toISOString();

  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'overview') {
    const [
      { count: totalUsers },
      { count: newUsers },
      { data: walletSums },
      { data: depositSums },
      { data: withdrawalSums }
    ] = await Promise.all([
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', fromDate).lte('created_at', toDate),
      supabase.from('wallets').select('balance, total_earned'),
      supabase.from('deposits').select('amount').eq('status', 'SUCCESSFUL'),
      supabase.from('withdrawals').select('amount').eq('status', 'PAID')
    ]);

    return res.status(200).json({
      success: true,
      data: {
        total_users: totalUsers,
        new_users_period: newUsers,
        platform_balance_liability: walletSums.reduce((s, x) => s + Number(x.balance), 0),
        total_earnings_distributed: walletSums.reduce((s, x) => s + Number(x.total_earned), 0),
        total_deposits_volume: depositSums.reduce((s, x) => s + Number(x.amount), 0),
        total_withdrawals_volume: withdrawalSums.reduce((s, x) => s + Number(x.amount), 0)
      }
    });
  }

  if (action === 'financial') {
    const { data: txs } = await supabase
      .from('transactions')
      .select('amount, type, status')
      .gte('created_at', fromDate)
      .lte('created_at', toDate);

    const report = {
      deposits: txs.filter(t => t.type === 'DEPOSIT').reduce((s, x) => s + Number(x.amount), 0),
      withdrawals: txs.filter(t => t.type === 'WITHDRAWAL').reduce((s, x) => s + Math.abs(Number(x.amount)), 0),
      investments: txs.filter(t => t.type === 'INVESTMENT').reduce((s, x) => s + Math.abs(Number(x.amount)), 0),
      earnings: txs.filter(t => t.type === 'EARNING').reduce((s, x) => s + Number(x.amount), 0),
      counts: {
        total: txs.length,
        success: txs.filter(t => t.status === 'SUCCESS').length,
        pending: txs.filter(t => t.status === 'PENDING').length
      }
    };
    return res.status(200).json({ success: true, data: report });
  }

  if (action === 'investments') {
    const { data: plans } = await supabase.from('plans').select('id, name');
    const { data: invs } = await supabase.from('investments').select('plan_id, amount, earned_amount, status');

    const planStats = plans.map(p => {
      const relevant = invs.filter(i => i.plan_id === p.id);
      return {
        plan_name: p.name,
        count: relevant.length,
        active: relevant.filter(i => i.status === 'ACTIVE').length,
        volume: relevant.reduce((s, x) => s + Number(x.amount), 0),
        returns_paid: relevant.reduce((s, x) => s + Number(x.earned_amount), 0)
      };
    });

    return res.status(200).json({ success: true, data: planStats });
  }

  if (action === 'rewards') {
    const { data: earns } = await supabase
      .from('earnings')
      .select('amount, type')
      .gte('created_at', fromDate)
      .lte('created_at', toDate);

    const rewards = {
      checkin: earns.filter(e => e.type === 'DAILY_CHECKIN').reduce((s, x) => s + Number(x.amount), 0),
      referral: earns.filter(e => e.type === 'REFERRAL').reduce((s, x) => s + Number(x.amount), 0),
      gift_code: earns.filter(e => e.type === 'GIFT_CODE').reduce((s, x) => s + Number(x.amount), 0),
      welcome_bonus: earns.filter(e => e.type === 'WELCOME_BONUS').reduce((s, x) => s + Number(x.amount), 0)
    };
    return res.status(200).json({ success: true, data: rewards });
  }

  return res.status(400).json({ success: false, message: 'Invalid report action' });
}

// ---------------------------------------------------------------------------
// SETTINGS  (formerly settings.js)
// ---------------------------------------------------------------------------
async function handlePublicSettings(res) {
  try {
    const publicKeys = [
      'platform_name', 'minimum_deposit', 'minimum_withdrawal',
      'welcome_bonus', 'daily_checkin_reward', 'referral_l1_percent',
      'referral_l2_percent', 'withdrawal_fee_percent', 'currency_symbol', 'platform_status'
    ];

    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', publicKeys);

    if (error) throw error;

    const config = data.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    return res.status(200).json({ success: true, data: config });
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Unable to load config' });
  }
}

async function handleAdminSettings({ method, action, body, adminId, res }) {
  if (method === 'GET' && action === 'admin') {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (method === 'POST' && action === 'update') {
    const { updates } = body;
    if (!Array.isArray(updates)) throw new Error('Invalid update format');

    for (const item of updates) {
      const val = parseFloat(item.value);
      if (item.key.includes('percent') || item.key.includes('rate')) {
        if (val < 0 || val > 100) throw new Error(`Invalid percentage for ${item.key}`);
      }
      if (item.key.includes('minimum') || item.key.includes('bonus') || item.key.includes('reward')) {
        if (val < 0) throw new Error(`Amount for ${item.key} cannot be negative`);
      }
    }

    const keysToUpdate = updates.map(u => u.key);
    const { data: oldValues } = await supabase.from('settings').select('*').in('key', keysToUpdate);

    const { error: updateError } = await supabase.from('settings').upsert(updates);
    if (updateError) throw updateError;

    await supabase.from('admin_audit_logs').insert({
      admin_id: adminId,
      action: 'PLATFORM_SETTINGS_UPDATE',
      target_type: 'SYSTEM',
      details: {
        changed_keys: keysToUpdate,
        previous: oldValues.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {}),
        new: updates.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {})
      }
    });

    return res.status(200).json({ success: true, message: 'Settings updated successfully' });
  }

  return res.status(400).json({ success: false, message: 'Invalid action' });
}
