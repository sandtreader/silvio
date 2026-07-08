// Route guard: spinner while the initial /me is in flight, redirect to
// /login when logged out. Market is deliberately not guarded (public browse).
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../api/auth';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (me === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
