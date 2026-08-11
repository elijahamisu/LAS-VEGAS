import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // 1. Method Check
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  // 2. Authorization (Vercel Cron Header or Environment Secret)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Also allow Vercel's internal cron signature
    if (req.headers['x-vercel-cron'] !== '1') {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  }

  try {
    // 3. Trigger the Authoritative DB Function
    const { data, error } = await supabase.rpc('process_daily_operations');

    if (error) throw error;

    // 4. Determine response status
    if (data.status === 'already_processed') {
      return res.status(200).json({ success: true, message: data.message, data });
    }

    if (!data.success) {
      return res.status(500).json({ success: false, message: data.message });
    }

    return res.status(200).json({ success: true, message: data.message, data });

  } catch (error) {
    console.error('[CRON ERROR]:', error.message);
    return res.status(500).json({ success: false, message: 'Daily processing failed' });
  }
}
