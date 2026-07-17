import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';

// Rol bazlı landing → /urunler (tüm roller ürün listesini okuyabilir).
export default function Home() {
  const user = getCurrentUser();
  if (!user) redirect('/login');
  redirect('/urunler');
}
