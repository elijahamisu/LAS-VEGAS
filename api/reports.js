import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query } = req;
  const action = query.action;

  // 1. Mandatory Admin Authorization Guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });
  
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });

  // Verify Admin Role in Database
  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile || !profile.is_admin) {
    return res.status(403).json({ success: false, message: 'Access denied: Admin only' });
  }

  // 2. Date Filter Setup (Africa/Lagos context)
  const fromDate = query.from || new Date(new Date().setDate(new Date().getDate() - 30)).toISOString();
  const toDate = query.to || new Date().toISOString();

  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    // 3. Action: OVERVIEW REPORT
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

    // 4. Action: FINANCIAL FLOW REPORT
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

    // 5. Action: INVESTMENT PERFORMANCE
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

    // 6. Action: REWARDS & REFERRALS
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

  } catch (error) {
    console.error('[REPORTS API ERROR]:', error.message);
    return res.status(400).json({ success: false, message: 'Unable to generate report' });
  }
}
