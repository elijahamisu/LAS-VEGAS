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
    // 3. Action: List Transactions (Paginated & Filtered)
    if (action === 'list') {
      const page = parseInt(query.page) || 0;
      const limit = Math.min(parseInt(query.limit) || 20, 50);
      const type = query.type; // e.g., DEPOSIT, INVESTMENT
      const status = query.status; // e.g., SUCCESS, PENDING
      
      const from = page * limit;
      const to = from + limit - 1;

      let dbQuery = supabase
        .from('transactions')
        .select('id, type, amount, status, description, reference, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Apply Filters if provided
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

    // 4. Action: Get Specific Transaction Details
    if (action === 'details') {
      const { id } = query;
      if (!id) throw new Error('Transaction ID is required');

      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId) // Ownership verification
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, message: 'Transaction not found or access denied' });
      }

      // Sanitize response: remove internal metadata if any
      const { user_id, ...safeDetails } = data;

      return res.status(200).json({ success: true, data: safeDetails });
    }

    return res.status(400).json({ success: false, message: 'Invalid transaction action' });

  } catch (error) {
    return res.status(400).json({ success: false, message: 'Unable to process transaction request' });
  }
}
