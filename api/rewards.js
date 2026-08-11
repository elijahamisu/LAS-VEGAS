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
    // 2. Action: Check-in Status
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

    // 3. Action: Perform Check-in (POST)
    if (method === 'POST' && action === 'checkin') {
      const { data, error } = await supabase.rpc('claim_daily_checkin');
      if (error) throw error;
      if (!data.success) throw new Error(data.message);
      return res.status(200).json({ success: true, message: '₦200 reward credited successfully', data });
    }

    // 4. Action: Redeem Gift Code (POST)
    if (method === 'POST' && action === 'redeem-gift') {
      const { gift_code } = body;
      if (!gift_code) throw new Error('Gift code is required');

      const { data, error } = await supabase.rpc('redeem_gift_code', { p_code: gift_code });
      if (error) throw error;
      if (!data.success) throw new Error(data.message);
      return res.status(200).json({ success: true, message: `₦${data.reward} reward credited`, data });
    }

    // 5. Action: Referral Summary (GET)
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

    // 6. Action: Referral History (GET)
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

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
