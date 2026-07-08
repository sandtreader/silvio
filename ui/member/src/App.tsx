// Router + theme + providers. Market is public (browse works logged out);
// everything else behind RequireAuth.
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider } from './api/auth';
import { FeedbackProvider } from './api/feedback';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { Activity } from './pages/Activity';
import { Apply } from './pages/Apply';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Market } from './pages/Market';
import { More } from './pages/More';
import { Pay } from './pages/Pay';

const theme = createTheme({
  palette: {
    primary: { main: '#2e7d32' },
    secondary: { main: '#6d4c41' },
  },
});

const router = createBrowserRouter([
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
      { path: '/market', element: <Market /> },
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
]);

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <FeedbackProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </FeedbackProvider>
    </ThemeProvider>
  );
}
