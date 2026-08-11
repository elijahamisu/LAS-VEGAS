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

  // 2. HTTP Method Enforcement (Read-Only)
  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    // 3. GET Earnings Summary
    if (action === 'summary') {
      const today = new Date().toISOString().split('T')[0];

      const { data: earnings, error } = await supabase
        .from('earnings')
        .select('amount, type, earning_date')
        .eq('user_id', userId);

      if (error) throw error;

      const summary = {
        total_earnings: 0,
        today_earnings: 0,
        investment_earnings: 0,
        referral_earnings: 0,
        checkin_rewards: 0,
        bonus_rewards: 0
      };

      earnings.forEach(e => {
        const amt = Number(e.amount);
        summary.total_earnings += amt;
        
        if (e.earning_date === today) summary.today_earnings += amt;
        
        switch (e.type) {
          case 'INVESTMENT': summary.investment_earnings += amt; break;
          case 'REFERRAL': summary.referral_earnings += amt; break;
          case 'DAILY_CHECKIN': summary.checkin_rewards += amt; break;
          case 'WELCOME_BONUS': 
          case 'GIFT_CODE': summary.bonus_rewards += amt; break;
        }
      });

      return res.status(200).json({ success: true, data: summary });
    }

    // 4. GET Paginated Earnings History
    if (action === 'list') {
      const page = parseInt(query.page) || 0;
      const limit = Math.min(parseInt(query.limit) || 20, 50);
      const type = query.type; // Optional filter
      const from = page * limit;
      const to = from + limit - 1;

      let dbQuery = supabase
        .from('earnings')
        .select('id, type, amount, description, earning_date, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (type && type !== 'ALL') {
        dbQuery = dbQuery.eq('type', type);
      }

      const { data, error, count } = await dbQuery.range(from, to);

      if (error) throw error;
      return res.status(200).json({
        success: true,
        data: {
          earnings: data,
          total: count,
          page,
          limit
        }
      });
    }

    // 5. GET Investment Earnings Specifics
    if (action === 'investment-stats') {
      const { data, error } = await supabase
        .from('investments')
        .select('id, amount, earned_amount, daily_profit, status, plans(name)')
        .eq('user_id', userId)
        .eq('status', 'ACTIVE');

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    return res.status(400).json({ success: false, message: 'Invalid earnings action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: 'Unable to retrieve earnings data' });
  }
}
