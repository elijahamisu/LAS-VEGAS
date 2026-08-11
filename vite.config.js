// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        register: resolve(__dirname, 'register.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        plans: resolve(__dirname, 'plans.html'),
        investment: resolve(__dirname, 'investment.html'),
        wallet: resolve(__dirname, 'wallet.html'),
        deposit: resolve(__dirname, 'deposit.html'),
        withdraw: resolve(__dirname, 'withdraw.html'),
        earnings: resolve(__dirname, 'earnings.html'),
        daily_checkin: resolve(__dirname, 'daily-checkin.html'),
        transactions: resolve(__dirname, 'transactions.html'),
        referrals: resolve(__dirname, 'referrals.html'),
        gift_code: resolve(__dirname, 'gift-code.html'),
        notifications: resolve(__dirname, 'notifications.html'),
        profile: resolve(__dirname, 'profile.html'),
        support: resolve(__dirname, 'support.html'),
        // Admin Entry
        admin_login: resolve(__dirname, 'admin/login.html'),
        admin_dashboard: resolve(__dirname, 'admin/index.html'),
        admin_users: resolve(__dirname, 'admin/users.html'),
        admin_user_details: resolve(__dirname, 'admin/user-details.html'),
        admin_plans: resolve(__dirname, 'admin/plans.html'),
        admin_investments: resolve(__dirname, 'admin/investments.html'),
        admin_earnings: resolve(__dirname, 'admin/earnings.html'),
        admin_deposits: resolve(__dirname, 'admin/deposits.html'),
        admin_withdrawals: resolve(__dirname, 'admin/withdrawals.html'),
        admin_transactions: resolve(__dirname, 'admin/transactions.html'),
        admin_daily_checkins: resolve(__dirname, 'admin/daily-checkins.html'),
        admin_referrals: resolve(__dirname, 'admin/referrals.html'),
        admin_gift_codes: resolve(__dirname, 'admin/gift-codes.html'),
        admin_notifications: resolve(__dirname, 'admin/notifications.html'),
        admin_nekpay: resolve(__dirname, 'admin/nekpay.html'),
       admin_payout_accounts: resolve(__dirname, 'admin/payout-accounts.html'),
      }
    }
  }
});
