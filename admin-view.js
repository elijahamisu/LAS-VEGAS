// admin-view.js
// Shared "view as user" helper for LAS VEGAS member pages.
// Drop this next to your other JS and import it from each member page.
//
// Usage in a page's init():
//   import { resolveEffectiveUser, injectAdminBanner, adminCall, adminizeLinks } from './admin-view.js';
//   const { isAdminMode, effectiveUserId } = await resolveEffectiveUser(supabase, session);
//   if (isAdminMode) { injectAdminBanner(); adminizeLinks(effectiveUserId); }
//   // then use `effectiveUserId` everywhere you previously used session.user.id

export async function resolveEffectiveUser(supabase, session) {
    const params = new URLSearchParams(window.location.search);
    const viewAsId = params.get('view_as');

    let isAdminMode = false;
    let effectiveUserId = session.user.id;

    if (viewAsId && viewAsId !== session.user.id) {
        const { data: adminProfile } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', session.user.id)
            .single();

        if (adminProfile && adminProfile.is_admin) {
            isAdminMode = true;
            effectiveUserId = viewAsId;
        }
        // If the requester isn't actually an admin, silently fall back to
        // their own id — no error message, just ignore the param.
    }

    return { isAdminMode, effectiveUserId };
}

export function injectAdminBanner() {
    if (document.getElementById('admin-mode-banner')) return; // don't double-inject
    const banner = document.createElement('div');
    banner.id = 'admin-mode-banner';
    banner.style.cssText = 'background:#121212;color:#fff;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;font-weight:700;position:sticky;top:0;z-index:5000;font-family:"Quicksand",sans-serif;';
    banner.innerHTML = `
        <span>🔴 ADMIN VIEW — viewing this member's live account. Any changes you save here are real.</span>
        <a href="admin/users.html" style="color:#fff;background:rgba(255,255,255,0.15);padding:6px 12px;border-radius:8px;text-decoration:none;">← Back to Users</a>
    `;
    document.body.prepend(banner);
}

// Rewrites this page's internal nav links (sidebar, nav-island, quick actions,
// etc.) so admin mode persists as the member navigates between pages.
// Call after the page's normal nav is rendered/attached.
export function adminizeLinks(effectiveUserId) {
    const internalPages = new Set([
        'dashboard.html', 'plans.html', 'my-investments.html', 'investment.html',
        'wallet.html', 'deposit.html', 'withdraw.html', 'daily-checkin.html',
        'referrals.html', 'notifications.html', 'profile.html', 'support.html',
        'transactions.html', 'gift-code.html'
    ]);

    document.querySelectorAll('a[href]').forEach(a => {
        try {
            const url = new URL(a.getAttribute('href'), window.location.href);
            const filename = url.pathname.split('/').pop();
            if (internalPages.has(filename)) {
                url.searchParams.set('view_as', effectiveUserId);
                a.setAttribute('href', url.pathname + url.search);
            }
        } catch (e) { /* ignore malformed hrefs */ }
    });

    // Also disable logout while in admin mode — logging out would sign the
    // admin themselves out of their own session, not the viewed user.
    document.querySelectorAll('#logout-btn, #logout-trigger, #confirm-logout').forEach(btn => {
        btn.textContent = btn.tagName === 'BUTTON' ? '🚪 Exit Admin View' : btn.textContent;
        btn.onclick = (e) => {
            e.preventDefault();
            window.location.href = 'admin/users.html';
        };
    });
}

// Admin API helper — every privileged write goes through /api/admin so it's
// audited and doesn't rely on client-side RLS write access to other users' rows.
export async function adminCall(session, action, body) {
    const res = await fetch(`/api/admin?resource=admin&action=${action}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.message || 'Request failed');
    return json;
}
