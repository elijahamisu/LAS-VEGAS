import { createClient } from '@supabase/supabase-js';
// NekPay internal service (abstraction for api/nekpay.js logic)
import { createNekpayPayment } from './nekpay.js'; 

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Authentication Guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Auth required' });
  const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });
  const userId = user.id;

  try {
    // 2. Action: Create Deposit
    if (action === 'create-deposit') {
      const { amount } = body;
      const { data: minDep } = await supabase.from('settings').select('value').eq('key', 'minimum_deposit').single();
      
      if (!amount || amount < Number(minDep.value)) {
        throw new Error(`Minimum deposit is ₦${minDep.value}`);
      }

      const reference = 'DEP-' + Math.random().toString(36).substring(2, 10).toUpperCase();

      // Create pending record in DB
      const { data: deposit, error: depErr } = await supabase.from('deposits').insert({
        user_id: userId,
        amount: parseFloat(amount),
        reference,
        status: 'PENDING'
      }).select().single();
      if (depErr) throw depErr;

      // Request actual NekPay URL via internal service
      // This calls the logic that will be built in api/nekpay.js
      const nekpayRes = await createNekpayPayment({
        amount: parseFloat(amount),
        reference,
        email: user.email
      });

      return res.status(200).json({ success: true, data: { checkout_url: nekpayRes.url, reference } });
    }

    // 3. Action: Create Withdrawal Request
    if (action === 'create-withdrawal') {
      const { amount, account_id } = body;
      if (!amount || !account_id) throw new Error('Amount and payout account required');

      // Execute atomic SQL function for reservation
      const { data: result, error: rpcErr } = await supabase.rpc('request_user_withdrawal', {
        p_user_id: userId,
        p_amount: parseFloat(amount),
        p_account_id: account_id
      });

      if (rpcErr) throw rpcErr;
      if (!result.success) throw new Error(result.message);

      return res.status(200).json({ success: true, message: 'Withdrawal request submitted for admin review.' });
    }

    // 4. Action: Payment History (Combined)
    if (action === 'history') {
      const page = parseInt(query.page) || 0;
      const type = query.type; // 'DEPOSIT' or 'WITHDRAWAL'
      
      let dbQuery;
      if (type === 'DEPOSIT') {
        dbQuery = supabase.from('deposits').select('*', { count: 'exact' });
      } else {
        dbQuery = supabase.from('withdrawals').select('*', { count: 'exact' });
      }

      const { data, count, error } = await dbQuery
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(page * 20, (page + 1) * 20 - 1);

      if (error) throw error;
      return res.status(200).json({ success: true, data: { list: data, total: count } });
    }

    return res.status(400).json({ success: false, message: 'Invalid payment action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
