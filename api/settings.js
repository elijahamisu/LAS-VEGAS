import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. PUBLIC SETTINGS (No Auth Required)
  if (method === 'GET' && action === 'public') {
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

      // Transform array to object for frontend ease of use
      const config = data.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
      return res.status(200).json({ success: true, data: config });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Unable to load config' });
    }
  }

  // 2. ADMIN AUTHORIZATION GUARD
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ success: false, message: 'Session expired' });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile || !profile.is_admin) return res.status(403).json({ success: false, message: 'Forbidden' });

  try {
    // 3. GET ADMIN SETTINGS
    if (method === 'GET' && action === 'admin') {
      const { data, error } = await supabase.from('settings').select('*');
      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // 4. POST UPDATE SETTINGS
    if (method === 'POST' && action === 'update') {
      const { updates } = body; // Expects array: [{key, value}, ...]

      if (!Array.isArray(updates)) throw new Error('Invalid update format');

      // Server-side Validation
      for (const item of updates) {
        const val = parseFloat(item.value);
        if (item.key.includes('percent') || item.key.includes('rate')) {
          if (val < 0 || val > 100) throw new Error(`Invalid percentage for ${item.key}`);
        }
        if (item.key.includes('minimum') || item.key.includes('bonus') || item.key.includes('reward')) {
          if (val < 0) throw new Error(`Amount for ${item.key} cannot be negative`);
        }
      }

      // Fetch existing values for Audit Trail
      const keysToUpdate = updates.map(u => u.key);
      const { data: oldValues } = await supabase.from('settings').select('*').in('key', keysToUpdate);

      // Perform Atomic Update
      const { error: updateError } = await supabase.from('settings').upsert(updates);
      if (updateError) throw updateError;

      // Log to Admin Audit
      await supabase.from('admin_audit_logs').insert({
        admin_id: user.id,
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

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
