const SLIPOK_URL = 'https://api.slipok.com/api/line/apikey';

export function slipOkConfigured() {
  return Boolean(process.env.SLIPOK_BRANCH_ID && process.env.SLIPOK_API_KEY);
}

export function slipAmount(data) {
  const value = data?.amount ?? data?.transAmount ?? data?.transRef?.amount;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function slipDate(data) {
  return data?.transDate ?? data?.date ?? data?.transRef?.transDate ?? null;
}

export function slipReceiver(data) {
  return data?.receiver?.displayName ?? data?.receiver?.name ?? data?.receivingBank ?? null;
}

export async function verifySlipImage(buffer, { contentType = 'image/jpeg', amount } = {}) {
  if (!slipOkConfigured()) {
    throw new Error('SlipOK is not configured');
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: contentType });
  form.append('files', blob, 'slip.jpg');
  form.append('log', 'true');
  if (amount != null) form.append('amount', String(amount));

  const response = await fetch(`${SLIPOK_URL}/${process.env.SLIPOK_BRANCH_ID}`, {
    method: 'POST',
    headers: { 'x-authorization': process.env.SLIPOK_API_KEY },
    body: form
  });

  const result = await response.json().catch(() => ({}));
  return {
    ok: response.ok && result.success === true,
    status: response.status,
    code: result.code,
    message: result.message,
    data: result.data ?? null
  };
}
