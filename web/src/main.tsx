import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { IconSprite } from './components/Icon';
import { Shell } from './components/Shell';
import { ToastProvider } from './lib/hooks';
import { Explore } from './pages/Explore';
import { Submit } from './pages/Submit';
import { AdminQueue, MePage, NotFound, Saved, SignIn } from './pages/Account';

const MapPage = lazy(() => import('./pages/MapPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    element: <ToastProvider><Shell /></ToastProvider>,
    children: [
      { path: '/', element: <Explore /> },
      { path: '/p/:slug', element: <Explore /> }, // shared links open the sheet over Explore
      { path: '/map', element: <Suspense fallback={<div className="sk" style={{ height: 600 }} />}><MapPage /></Suspense> },
      { path: '/add', element: <Submit /> },
      { path: '/saved', element: <Saved /> },
      { path: '/me', element: <MePage /> },
      { path: '/signin', element: <SignIn /> },
      { path: '/admin', element: <AdminQueue /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <IconSprite />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
