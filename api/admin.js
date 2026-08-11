import { createClient } from '@supabase/supabase-js';
import { processNekpayPayout } from './nekpay.js';

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Mandatory Admin Authorization Check
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return res.status(403).json({ success: false, message: 'Access Denied: Admin role required' });

  try {
    // 2. GET Actions (Read operations)
    if (method === 'GET') {
      // Dashboard Statistics
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

      // User List (Paginated)
      if (action === 'users') {
        const page = parseInt(query.page) || 0;
        const { data, count } = await supabase.from('profiles').select('*, wallets(balance)', { count: 'exact' })
          .order('created_at', { ascending: false }).range(page * 20, (page + 1) * 20 - 1);
        return res.status(200).json({ success: true, data: { list: data, total: count } });
      }

      // User Details (Deep dive)
      if (action === 'user-details') {
        const { id } = query;
        const [{ data: p }, { data: w }, { data: inv }] = await Promise.all([
          supabase.from('profiles').select('*').eq('id', id).single(),
          supabase.from('wallets').select('*').eq('user_id', id).single(),
          supabase.from('investments').select('*, plans(name)').eq('user_id', id)
        ]);
        return res.status(200).json({ success: true, data: { profile: p, wallet: w, investments: inv } });
      }

      // Settings Load
      if (action === 'settings') {
        const { data } = await supabase.from('settings').select('*');
        return res.status(200).json({ success: true, data });
      }
    }

    // 3. POST Actions (Write operations)
    if (method === 'POST') {
      // Withdrawal: Approve
      if (action === 'approve-withdrawal') {
        const { id } = body;
        const { data, error } = await supabase.rpc('admin_approve_withdrawal', { p_admin_id: user.id, p_withdrawal_id: id });
        if (error || !data.success) throw new Error(data?.message || 'Approval failed');
        return res.status(200).json({ success: true, message: 'Withdrawal approved. Ready for payout.' });
      }

      // Withdrawal: Reject
      if (action === 'reject-withdrawal') {
        const { id, reason } = body;
        const { data, error } = await supabase.rpc('admin_reject_withdrawal', { p_admin_id: user.id, p_withdrawal_id: id, p_reason: reason });
        if (error || !data.success) throw new Error(data?.message || 'Rejection failed');
        return res.status(200).json({ success: true, message: 'Withdrawal rejected and funds released.' });
      }

      // Nekpay: Initiate Disbursement (Final Step)
      if (action === 'payout-withdrawal') {
        const { id } = body;
        const { data: wd } = await supabase.from('withdrawals').select('*, withdrawal_accounts(*)').eq('id', id).single();
        if (wd.status !== 'APPROVED') throw new Error('Disbursement requires previous admin approval');

        // Mark as Processing
        await supabase.from('withdrawals').update({ status: 'PROCESSING' }).eq('id', id);

        // Call NekPay Adapter
        const payout = await processNekpayPayout({
          reference: wd.reference,
          net_amount: wd.net_amount,
          bank_code: wd.withdrawal_accounts.bank_code, // Assuming mapping exists
          account_number: wd.withdrawal_accounts.account_number,
          account_name: wd.withdrawal_accounts.account_name
        });

        if (payout.success) {
          await supabase.from('withdrawals').update({ status: 'PAID', payout_reference: payout.providerReference, processed_at: now() }).eq('id', id);
          return res.status(200).json({ success: true, message: 'Funds disbursed via NekPay' });
        } else {
          await supabase.from('withdrawals').update({ status: 'FAILED' }).eq('id', id);
          throw new Error(payout.message);
        }
      }

      // Settings: Update
      if (action === 'update-settings') {
        const { updates } = body; // Array of {key, value}
        const { error } = await supabase.from('settings').upsert(updates);
        if (error) throw error;
        await supabase.from('admin_audit_logs').insert({ admin_id: user.id, action: 'SETTINGS_UPDATE', details: updates });
        return res.status(200).json({ success: true, message: 'Settings updated' });
      }
    }

    return res.status(400).json({ success: false, message: 'Invalid admin action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
