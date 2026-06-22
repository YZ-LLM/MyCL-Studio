import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/session';
import { navForRole } from '@/lib/nav-config';
import { getHelpPages } from '@/lib/help.server';
import { AppShell } from '@/components/AppShell';
import { ToastProvider } from '@/components/ToastProvider';

// Korumalı layout — oturum yoksa /login'e (gerçek gate; middleware yalnız UX guard).
export default function AppLayout({ children }) {
  const user = getCurrentUser();
  if (!user) redirect('/login');

  const safeUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
  };
  const navItems = navForRole(user.role);
  const helpPages = getHelpPages(); // server-only fs okuması burada; client'a prop olarak iner

  return (
    <ToastProvider>
      <AppShell user={safeUser} navItems={navItems} helpPages={helpPages}>
        {children}
      </AppShell>
    </ToastProvider>
  );
}
