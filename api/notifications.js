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
    // 2. Action: List Notifications (Personal + Platform-wide)
    if (method === 'GET' && action === 'list') {
      const page = parseInt(query.page) || 0;
      const limit = Math.min(parseInt(query.limit) || 20, 50);
      const from = page * limit;
      const to = from + limit - 1;

      const { data, error, count } = await supabase
        .from('notifications')
        .select('id, title, message, type, is_read, created_at', { count: 'exact' })
        // Fetch personal notifications OR global announcements (where user_id is null)
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

    // 3. Action: Unread Count (Efficient Head Query)
    if (method === 'GET' && action === 'unread-count') {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);

      if (error) throw error;
      return res.status(200).json({ success: true, data: { unread: count || 0 } });
    }

    // 4. Action: Mark One as Read (Ownership Secured)
    if (method === 'POST' && action === 'read') {
      const { notification_id } = body;
      if (!notification_id) throw new Error('Notification ID required');

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notification_id)
        .eq('user_id', userId); // SECURITY: Ensure user owns this notification

      if (error) throw error;
      return res.status(200).json({ success: true, message: 'Marked as read' });
    }

    // 5. Action: Mark All as Read (Scoped to Current User)
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

  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
