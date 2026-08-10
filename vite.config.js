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
      }
    }
  }
});
