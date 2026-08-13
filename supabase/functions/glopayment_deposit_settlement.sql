-- GloPayment deposit callback settlement for LAS-VEGAS
--
-- Run this once in: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- The Vercel webhook calls process_glopayment_deposit only AFTER it has verified
-- the GloPayment signature and merchant ID. This SQL provides the second safety
-- layer: it locks the matching pending deposit, verifies the provider and amount,
-- records callback metadata, and credits the wallet exactly once.

alter table public.deposits
  add column if not exists provider_order_id text,
  add column if not exists provider_merchant_id text,
  add column if not exists provider_return_code text,
  add column if not exists paid_at timestamptz,
  add column if not exists provider_callback jsonb;

create or replace function public.process_glopayment_deposit(
  p_merchant_order_id text,
  p_provider_order_id text,
  p_merchant_id text,
  p_amount numeric,
  p_return_code text,
  p_callback jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deposit public.deposits%rowtype;
begin
  -- Locking makes two concurrent/retried callbacks serialize safely.
  select *
    into v_deposit
    from public.deposits
   where reference = p_merchant_order_id
     and provider = 'glopayment'
   for update;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Unknown GloPayment deposit reference');
  end if;

  if v_deposit.amount <> p_amount then
    return jsonb_build_object('success', false, 'message', 'Callback amount does not match pending deposit');
  end if;

  -- A repeat callback after a successful credit must be harmless.
  if v_deposit.status = 'SUCCESSFUL' then
    return jsonb_build_object('success', true, 'duplicate', true, 'message', 'Deposit was already settled');
  end if;

  -- A provider may retry a failed callback. Store its final status but never
  -- credit a wallet unless the documented success code is exactly 00.
  if p_return_code <> '00' then
    update public.deposits
       set status = 'FAILED',
           provider_order_id = p_provider_order_id,
           provider_merchant_id = p_merchant_id,
           provider_return_code = p_return_code,
           provider_callback = p_callback
     where id = v_deposit.id;

    return jsonb_build_object('success', true, 'credited', false, 'message', 'Failure callback recorded');
  end if;

  if v_deposit.status <> 'PENDING' then
    return jsonb_build_object('success', false, 'message', 'Deposit is not eligible for settlement');
  end if;

  update public.wallets
     set balance = coalesce(balance, 0) + p_amount
   where user_id = v_deposit.user_id;

  if not found then
    return jsonb_build_object('success', false, 'message', 'Wallet not found for deposit user');
  end if;

  update public.deposits
     set status = 'SUCCESSFUL',
         provider_order_id = p_provider_order_id,
         provider_merchant_id = p_merchant_id,
         provider_return_code = p_return_code,
         provider_callback = p_callback,
         paid_at = now()
   where id = v_deposit.id;

  insert into public.transactions (user_id, amount, type, status, description)
  values (
    v_deposit.user_id,
    p_amount,
    'DEPOSIT',
    'SUCCESS',
    'GloPayment wallet top-up: ' || p_merchant_order_id
  );

  return jsonb_build_object('success', true, 'duplicate', false, 'credited', true);
end;
$$;

-- The Vercel API uses SUPABASE_SERVICE_ROLE_KEY. Do not expose that key in the browser.
revoke all on function public.process_glopayment_deposit(text, text, text, numeric, text, jsonb) from public;
grant execute on function public.process_glopayment_deposit(text, text, text, numeric, text, jsonb) to service_role;
