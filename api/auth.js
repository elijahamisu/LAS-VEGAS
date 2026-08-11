// api/auth.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { action, email, password, full_name, referral_code } = req.body;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    if (action === 'register') {
      // 1. Create Auth User
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (authError) throw authError;

      const userId = authData.user.id;

      // 2. Determine Referrer
      let referredById = null;
      if (referral_code) {
        const { data: refProfile } = await supabase
          .from('profiles')
          .select('id')
          .eq('referral_code', referral_code.toUpperCase())
          .single();
        referredById = refProfile?.id || null;
      }

      // 3. Create Profile
      const myNewRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const { error: profError } = await supabase.from('profiles').insert({
        id: userId,
        full_name,
        email,
        referral_code: myNewRefCode,
        referred_by: referredById
      });
      if (profError) throw profError;

      // 4. Create Wallet & ₦1,000 Welcome Bonus (Atomic-ish sequence)
      const { error: walletError } = await supabase.from('wallets').insert({
        user_id: userId,
        balance: 1000.00,
        total_earned: 1000.00
      });
      if (walletError) throw walletError;

      // 5. Log Welcome Transaction
      await supabase.from('transactions').insert({
        user_id: userId,
        amount: 1000.00,
        type: 'WELCOME_BONUS',
        status: 'SUCCESS',
        description: 'Initial platform welcome reward'
      });

      return res.status(200).json({ success: true, message: 'Account created and bonus credited.' });
    }

    if (action === 'login') {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return res.status(200).json({ success: true, session: data.session });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
