# GloPayment Nigeria Withdrawal Flow

The repository now supports **administrator-approved GloPayment withdrawals** on the merchant portal’s **Nigeria Category I Payment** channel `506`. This replaces the legacy NekPay payout route for newly saved withdrawal accounts. The user withdrawal request remains subject to the existing approval process; only an authorized administrator can submit the payout.

> A synchronous GloPayment response with `status: "200"` means the payout request was accepted. It does **not** prove the beneficiary received money. The withdrawal remains `PROCESSING` until the signed GloPayment callback returns `returnCode: "00"`. [1]

## Required configuration

Set these server-only values in **Vercel → Project → Settings → Environment Variables**, then redeploy the project.

| Variable | Required value |
|---|---|
| `GLOPAYMENT_HOST` | The production API host confirmed by GloPayment. |
| `GLOPAYMENT_MERCHANT_ID` | Merchant ID from the GloPayment portal. |
| `GLOPAYMENT_PAYMENT_KEY` | Value revealed by **Payment Key**, not Key collection. |
| `GLOPAYMENT_NGN_PAYOUT_CHANNEL_CODE` | `506`, the enabled Nigeria Category I Payment channel. |
| `GLOPAYMENT_WITHDRAW_NOTIFY_URL` | `https://YOUR-DOMAIN/api/webhook?type=glopay-withdrawal` |
| `GLOPAYMENT_NGN_PAYOUT_NUMBER_MODE` | Provider-confirmed `account_number`, `mobile`, or `static`. |
| `GLOPAYMENT_NGN_PAYOUT_NUMBER` | Only required if GloPayment confirms `static` mode. |

Use this in the merchant portal’s **Payment callback address** field:

```text
https://YOUR-DOMAIN/api/webhook?type=glopay-withdrawal
```

The existing **Recall address** remains the deposit-only callback:

```text
https://YOUR-DOMAIN/api/webhook?type=glopay
```

## Payout workflow

| Step | System action |
|---|---|
| 1 | A user selects a GloPayment payout account and requests a withdrawal. |
| 2 | The existing database function creates the pending withdrawal under the current approval rules. |
| 3 | An administrator approves the withdrawal. |
| 4 | The administrator selects **Payout**. The API checks the beneficiary account, profile contact data, GloPayment `800...` bank code, environment variables, and number mapping before contacting GloPayment. |
| 5 | The API submits `POST {$HOST}/payment/order/actions/commit` and sets the record to `PROCESSING` only after preflight checks pass. [1] |
| 6 | The signed `?type=glopay-withdrawal` callback sets the withdrawal to `PAID` only for `returnCode: "00"`; other final provider results are recorded as `FAILED`. |

## Bank accounts

`GET /api/finance?resource=withdrawals&action=bank-list` now returns `lib/glopayment-ngn-banks.js`, generated from GloPayment’s `NGN_native_02.xlsx` reference file. These codes begin with `800...` and are **not interchangeable** with old NekPay `NGR...` codes.

Users with a saved legacy NekPay payout account must add a new GloPayment payout account before making new withdrawal requests. The API intentionally excludes old accounts from the selectable GloPayment account list rather than risk routing a bank transfer with the wrong provider code.

## Supabase migration

Run `supabase/functions/glopayment_withdrawal_callback.sql` once in **Supabase Dashboard → SQL Editor**. It adds callback audit columns and creates `process_glopayment_withdrawal_callback`, which locks each withdrawal row to make repeated callbacks idempotent.

## One confirmation required before live payouts

GloPayment’s public payout document makes a field called `number` mandatory but does not define its Nigeria meaning. Do not enable payout submission until GloPayment confirms whether this value must be the beneficiary account number, mobile number, a fixed merchant value, or another identifier. Set `GLOPAYMENT_NGN_PAYOUT_NUMBER_MODE` to the confirmed mode.

Send this to GloPayment:

> For merchant `500001045`, we are using Nigeria Category I Payment channel `506`. Please confirm the required Nigeria value for the mandatory payout field `number` in `POST {$HOST}/payment/order/actions/commit`. Is it the account number, mobile number, a fixed value, or another identifier? Please also confirm that `NGN_native_02.xlsx` is the bank-code list for this channel.

## Reference

[1] [GloPayment API Documentation](https://glopayment.net/#/document)
