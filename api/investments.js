import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Authentication Guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Authentication required' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });
  const userId = user.id;

  try {
    // 2. GET Available Plans
    if (method === 'GET' && action === 'plans') {
      const { data, error } = await supabase
        .from('plans')
        .select('id, name, min_amount, daily_percent, duration_days, purchase_limit, is_active')
        .eq('is_active', true)
        .order('min_amount', { ascending: true });

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // 3. POST Purchase Investment (Balance-based)
    if (method === 'POST' && action === 'purchase') {
      const { plan_id, amount } = body;

      if (!plan_id || !amount || isNaN(amount) || amount <= 0) {
        throw new Error('Invalid plan ID or amount');
      }

      // Call the atomic SQL function
      const { data, error } = await supabase.rpc('process_investment_purchase', {
        p_user_id: userId,
        p_plan_id: plan_id,
        p_amount: parseFloat(amount)
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.message);

      return res.status(200).json({ success: true, message: data.message });
    }

    // 4. GET User Investment List
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

    // 5. GET Investment Details (Ownership secured)
    if (method === 'GET' && action === 'details') {
      const { id } = query;
      if (!id) throw new Error('Investment ID required');

      const { data, error } = await supabase
        .from('investments')
        .select('*, plans(*)')
        .eq('id', id)
        .eq('user_id', userId) // Security boundary
        .single();

      if (error || !data) throw new Error('Investment not found or access denied');
      return res.status(200).json({ success: true, data });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
