import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { IconSprite } from './components/Icon';
import { Shell } from './components/Shell';
import { ToastProvider } from './lib/hooks';
import { registerServiceWorker } from './lib/pwa';
import HomePage from './pages/HomePage';
import { Submit } from './pages/Submit';
import { Connect } from './pages/Connect';
import { AdminQueue, CrashPage, MePage, noteCrash, NotFound, Saved, SignIn } from './pages/Account';
import { BASE } from './lib/base';

const AgentsPage = lazy(() => import('./pages/Agents'));
const InsightsPage = lazy(() => import('./pages/Insights'));

registerServiceWorker();

// iOS Safari only shows :active press states when the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true });

// The old map page now lives on the home page. Old links keep their filters.
function MapRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    element: <ToastProvider><Shell /></ToastProvider>,
    errorElement: <CrashPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/p/:slug', element: <HomePage /> }, // shared links open the sheet over the map
      { path: '/map', element: <MapRedirect /> },
      { path: '/add', element: <Submit /> },
      { path: '/saved', element: <Saved /> },
      { path: '/connect', element: <Connect /> },
      { path: '/me', element: <MePage /> },
      { path: '/signin', element: <SignIn /> },
      { path: '/admin', element: <AdminQueue /> },
      { path: '/admin/agent', element: <Suspense fallback={null}><AgentsPage /></Suspense> },
      { path: '/admin/insights', element: <Suspense fallback={null}><InsightsPage /></Suspense> },
      { path: '*', element: <NotFound /> },
    ],
  },
// The trailing slash matters: with basename '/spotted-london' React Router writes the home page as
// '/spotted-london' (no slash), which is outside the manifest scope '/spotted-london/', so the iOS home screen
// app shows its browser bar. With '/spotted-london/' every address keeps its slash.
], { basename: BASE ? `${BASE}/` : undefined });

createRoot(document.getElementById('root')!, { onCaughtError: (_e, info) => noteCrash(info) }).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <IconSprite />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
