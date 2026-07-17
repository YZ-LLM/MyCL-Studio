'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import { handleProductRequest } from '@/lib/products-service';

// Server Actions for the no-JS-friendly product forms. RBAC, validation and
// persistence all flow through the single product service (same code path the
// REST API uses), so the action only translates the service result into the
// shape the form component expects.
function toFormState(result) {
  const { status, body } = result;
  if (status === 401) return { ok: false, error: 'UNAUTHENTICATED' };
  if (status === 403) return { ok: false, error: 'FORBIDDEN' };
  if (status === 400) return { ok: false, fieldErrors: body.error.fields || {} };
  if (status === 409) return { ok: false, fieldErrors: { code: 'conflict' } };
  if (status === 404) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true };
}

export async function createProductAction(_prevState, formData) {
  const user = getCurrentUser();
  const raw = Object.fromEntries(formData.entries());
  const result = handleProductRequest({ method: 'POST', user, body: raw });
  if (result.status !== 201) return toFormState(result);
  revalidatePath('/urunler');
  redirect('/urunler');
}

export async function updateProductAction(_prevState, formData) {
  const user = getCurrentUser();
  const id = Number(formData.get('id'));
  const raw = Object.fromEntries(formData.entries());
  const result = handleProductRequest({ method: 'PUT', user, id, body: raw });
  if (result.status !== 200) return toFormState(result);
  revalidatePath('/urunler');
  redirect('/urunler');
}

export async function deleteProductAction(id) {
  const user = getCurrentUser();
  const result = handleProductRequest({ method: 'DELETE', user, id: Number(id) });
  return toFormState(result);
}
