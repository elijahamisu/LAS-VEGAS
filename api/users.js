import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Authentication Guard
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });
  const userId = user.id;

  try {
    // 2. GET Profile Info
    if (method === 'GET' && action === 'profile') {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, referral_code, phone_number, avatar_url, created_at, status')
        .eq('id', userId)
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // 3. POST Update Profile
    if (method === 'POST' && action === 'update-profile') {
      const { full_name, phone_number, avatar_url } = body;

      // Filter only allowed fields to prevent privilege escalation
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

    // 4. GET Account Statistics
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

    // 5. GET Referral Summary
    if (method === 'GET' && action === 'referrals') {
      // Level 1: Direct referrals
      const { data: l1Users } = await supabase.from('profiles').select('id').eq('referred_by', userId);
      const l1Ids = l1Users?.map(u => u.id) || [];

      // Level 2: Indirect referrals
      let l2Count = 0;
      if (l1Ids.length > 0) {
        const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).in('referred_by', l1Ids);
        l2Count = count || 0;
      }

      // Commissions
      const { data: commissions } = await supabase.from('referral_commissions').select('amount, level').eq('user_id', userId);
      const l1Earned = commissions?.filter(c => c.level === 1).reduce((s, c) => s + Number(c.amount), 0) || 0;
      const l2Earned = commissions?.filter(c => c.level === 2).reduce((s, c) => s + Number(c.amount), 0) || 0;

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

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
