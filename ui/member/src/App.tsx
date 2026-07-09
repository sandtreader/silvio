// Router + theme + providers. The app is logged-in-only (decision #12):
// every tab sits behind RequireAuth; served at /app/, so the router
// basename is /app. The brochure-style chrome is rendered here by
// SiteChrome from GET /shell (decision #15) — outside the router, since
// its links leave the SPA.
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider } from './api/auth';
import { FeedbackProvider } from './api/feedback';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { SiteChrome } from './components/SiteChrome';
import { Activity } from './pages/Activity';
import { Apply } from './pages/Apply';
import { Forgot } from './pages/Forgot';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Market } from './pages/Market';
import { More } from './pages/More';
import { Pay } from './pages/Pay';
import { Reset } from './pages/Reset';
import { Verify } from './pages/Verify';

const theme = createTheme({
  palette: {
    primary: { main: '#2e7d32' },
    secondary: { main: '#6d4c41' },
  },
});

const routes = [
  {
    element: <Layout />,
    children: [
      {
        path: '/',
        element: (
          <RequireAuth>
            <Home />
          </RequireAuth>
        ),
      },
      {
        path: '/market',
        element: (
          <RequireAuth>
            <Market />
          </RequireAuth>
        ),
      },
      {
        path: '/pay',
        element: (
          <RequireAuth>
            <Pay />
          </RequireAuth>
        ),
      },
      {
        path: '/activity',
        element: (
          <RequireAuth>
            <Activity />
          </RequireAuth>
        ),
      },
      {
        path: '/more',
        element: (
          <RequireAuth>
            <More />
          </RequireAuth>
        ),
      },
    ],
  },
  { path: '/login', element: <Login /> },
  { path: '/apply', element: <Apply /> },
  // Public token/email flows: the emails link to /app/reset and /app/verify.
  { path: '/forgot', element: <Forgot /> },
  { path: '/reset', element: <Reset /> },
  { path: '/verify', element: <Verify /> },
];

const router = createBrowserRouter(routes, { basename: '/app' });

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <FeedbackProvider>
        <AuthProvider>
          <SiteChrome />
          <RouterProvider router={router} />
        </AuthProvider>
      </FeedbackProvider>
    </ThemeProvider>
  );
}
