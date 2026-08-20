import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Was: users.js + wallet.js + earnings.js + transactions.js + notifications.js
// Route with ?resource=profile|wallet|earnings|transactions|notifications&action=...
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
      case 'profile':
        return await handleProfile({ method, action, body, userId, res });
      case 'wallet':
        return await handleWallet({ method, action, query, userId, res });
      case 'earnings':
        return await handleEarnings({ method, action, query, userId, res });
      case 'transactions':
        return await handleTransactions({ method, action, query, userId, res });
      case 'notifications':
        return await handleNotifications({ method, action, query, body, userId, res });
      default:
        return res.status(400).json({ success: false, message: 'Invalid or missing resource' });
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}

// ---------------------------------------------------------------------------
// PROFILE  (formerly users.js)
// ---------------------------------------------------------------------------
async function handleProfile({ method, action, body, userId, res }) {
  if (method === 'GET' && action === 'profile') {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, referral_code, phone_number, avatar_url, created_at, status')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (method === 'POST' && action === 'update-profile') {
    const { full_name, phone_number, avatar_url } = body;

    const updates = {};
    if (full_name) updates.full_name = full_name.trim();
    if (phone_number) updates.phone_number = phone_number.trim();
    if (avatar_url) updates.avatar_url = avatar_url;

    if (Object.keys(updates).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (method === 'GET' && action === 'stats') {
    const [
      { count: totalInvs },
      { count: activeInvs },
      { data: wallet }
    ] = await Promise.all([
      supabase.from('investments').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('investments').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'ACTIVE'),
      supabase.from('wallets').select('total_earned, balance').eq('user_id', userId).single()
    ]);

    return res.status(200).json({
      success: true,
      data: {
        total_investments: totalInvs || 0,
        active_investments: activeInvs || 0,
        total_earned: wallet?.total_earned || 0,
        current_balance: wallet?.balance || 0
      }
    });
  }

  if (method === 'GET' && action === 'referrals') {
    const { data: l1Users } = await supabase.from('profiles').select('id').eq('referred_by', userId);
    const l1Ids = l1Users?.map(u => u.id) || [];

    let l2Count = 0;
    if (l1Ids.length > 0) {
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).in('referred_by', l1Ids);
      l2Count = count || 0;
    }

    const { data: commissions } = await supabase.from('referral_commissions').select('commission_amount, level').eq('user_id', userId);
    const l1Earned = commissions?.filter(c => c.level === 1).reduce((s, c) => s + Number(c.commission_amount), 0) || 0;
    const l2Earned = commissions?.filter(c => c.level === 2).reduce((s, c) => s + Number(c.commission_amount), 0) || 0;

    return res.status(200).json({
      success: true,
      data: {
        l1_count: l1Ids.length,
        l2_count: l2Count,
        l1_earned: l1Earned,
        l2_earned: l2Earned,
        total_earned: l1Earned + l2Earned
      }
    });
  }

  return res.status(400).json({ success: false, message: 'Invalid action' });
}

// ---------------------------------------------------------------------------
// WALLET  (formerly wallet.js) — read-only
// ---------------------------------------------------------------------------
async function handleWallet({ method, action, query, userId, res }) {
  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'summary') {
    const { data, error } = await supabase
      .from('wallets')
      .select('balance, total_deposited, total_withdrawn, investment_balance, total_earned')
      .eq('user_id', userId)
      .single();

    if (error) throw error;
    return res.status(200).json({ success: true, data });
  }

  if (action === 'balance') {
    const { data, error } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (error) throw error;
    return res.status(200).json({ success: true, data: { balance: data.balance } });
  }

  if (action === 'transactions') {
    const page = parseInt(query.page) || 0;
    const limit = Math.min(parseInt(query.limit) || 20, 50);
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
      data: { transactions: data, total: count, page, limit }
    });
  }

  return res.status(400).json({ success: false, message: 'Invalid wallet action' });
}

// ---------------------------------------------------------------------------
// EARNINGS  (formerly earnings.js) — read-only
// ---------------------------------------------------------------------------
async function handleEarnings({ method, action, query, userId, res }) {
  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

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

  if (action === 'list') {
    const page = parseInt(query.page) || 0;
    const limit = Math.min(parseInt(query.limit) || 20, 50);
    const type = query.type;
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
      data: { earnings: data, total: count, page, limit }
    });
  }

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
}

// ---------------------------------------------------------------------------
// TRANSACTIONS  (formerly transactions.js) — read-only
// ---------------------------------------------------------------------------
async function handleTransactions({ method, action, query, userId, res }) {
  if (method !== 'GET') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  if (action === 'list') {
    const page = parseInt(query.page) || 0;
    const limit = Math.min(parseInt(query.limit) || 20, 50);
    const type = query.type;
    const status = query.status;

    const from = page * limit;
    const to = from + limit - 1;

    let dbQuery = supabase
      .from('transactions')
      .select('id, type, amount, status, description, reference, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (type && type !== 'ALL') dbQuery = dbQuery.eq('type', type);
    if (status && status !== 'ALL') dbQuery = dbQuery.eq('status', status);

    const { data, error, count } = await dbQuery.range(from, to);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      data: {
        transactions: data,
        page,
        limit,
        total: count,
        hasMore: (page + 1) * limit < count
      }
    });
  }

  if (action === 'details') {
    const { id } = query;
    if (!id) throw new Error('Transaction ID is required');

    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'Transaction not found or access denied' });
    }

    const { user_id, ...safeDetails } = data;
    return res.status(200).json({ success: true, data: safeDetails });
  }

  return res.status(400).json({ success: false, message: 'Invalid transaction action' });
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS  (formerly notifications.js)
// ---------------------------------------------------------------------------
async function handleNotifications({ method, action, query, body, userId, res }) {
  if (method === 'GET' && action === 'list') {
    const page = parseInt(query.page) || 0;
    const limit = Math.min(parseInt(query.limit) || 20, 50);
    const from = page * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
      .from('notifications')
      .select('id, title, message, type, is_read, created_at', { count: 'exact' })
      .or(`user_id.eq.${userId},user_id.is.null`)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return res.status(200).json({
      success: true,
      data: {
        notifications: data,
        total: count,
        page,
        limit,
        hasMore: (page + 1) * limit < count
      }
    });
  }

  if (method === 'GET' && action === 'unread-count') {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw error;
    return res.status(200).json({ success: true, data: { unread: count || 0 } });
  }

  if (method === 'POST' && action === 'read') {
    const { notification_id } = body;
    if (!notification_id) throw new Error('Notification ID required');

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notification_id)
      .eq('user_id', userId);

    if (error) throw error;
    return res.status(200).json({ success: true, message: 'Marked as read' });
  }

  if (method === 'POST' && action === 'read-all') {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw error;
    return res.status(200).json({ success: true, message: 'All notifications marked as read' });
  }

  return res.status(400).json({ success: false, message: 'Invalid notification action' });
}
