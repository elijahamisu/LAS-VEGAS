import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query } = req;
  const action = query.action;

  // 1. Authentication Guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Authentication required' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });
  const userId = user.id;

  // This API is strictly READ-ONLY for users
  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    // 2. GET Wallet Summary
    if (action === 'summary') {
      const { data, error } = await supabase
        .from('wallets')
        .select('balance, total_deposited, total_withdrawn, investment_balance, total_earned')
        .eq('user_id', userId)
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // 3. GET Specific Balance
    if (action === 'balance') {
      const { data, error } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, data: { balance: data.balance } });
    }

    // 4. GET Paginated Transactions
    if (action === 'transactions') {
      const page = parseInt(query.page) || 0;
      const limit = Math.min(parseInt(query.limit) || 20, 50); // Hard cap at 50 for performance
      const from = page * limit;
      const to = from + limit - 1;

      const { data, error, count } = await supabase
        .from('transactions')
        .select('id, type, amount, status, description, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) throw error;
      return res.status(200).json({ 
        success: true, 
        data: {
          transactions: data,
          total: count,
          page,
          limit
        } 
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid wallet action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: 'Unable to retrieve wallet data' });
  }
}
