import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use Service Role Key to bypass RLS for administrative account setup
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const action = query.action || body.action;

  // 1. Session Check (GET)
  if (method === 'GET' && action === 'session') {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'No session found' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(401).json({ success: false, message: 'Session expired' });
    return res.status(200).json({ success: true, user });
  }

  if (method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    // 2. Login Logic
    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) throw new Error('Email and password required');

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error('Invalid login credentials');

      return res.status(200).json({ success: true, session: data.session });
    }

    // 3. Registration Logic
    if (action === 'register') {
      const { email, password, full_name, referral_code, gift_code } = body;

      // Basic Validation
      if (!email || !password || !full_name) throw new Error('Missing required fields');
      if (password.length < 6) throw new Error('Password too short');

      // A. Create Auth User
      const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
      if (authError) throw authError;
      const userId = authData.user.id;

      // B. Determine Referrer (Strict check)
      let referredById = null;
      if (referral_code) {
        const { data: sponsor } = await supabase.from('profiles')
          .select('id').eq('referral_code', referral_code.toUpperCase()).single();
        referredById = sponsor?.id || null;
      }

      // C. Generate Unique Referral Code for User
      const myRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();

      // D. Atomic Account Initialization
      // We use the service role to ensure these happen regardless of user RLS
      const { error: setupError } = await supabase.rpc('initialize_new_user', {
        p_user_id: userId,
        p_full_name: full_name,
        p_email: email,
        p_ref_code: myRefCode,
        p_referred_by: referredById,
        p_welcome_bonus: 1000.00
      });

      if (setupError) throw setupError;

      // E. Optional: Process Gift Code during registration
      if (gift_code) {
        // We call our existing redeem function
        await supabase.rpc('redeem_gift_code', { p_code: gift_code, p_user_id: userId });
      }

      return res.status(200).json({
        success: true,
        message: 'Registration successful. Welcome bonus of \u20a61,000 credited.'
      });
    }

    // 4. Logout Logic
    if (action === 'logout') {
      await supabase.auth.signOut();
      return res.status(200).json({ success: true, message: 'Logged out' });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
