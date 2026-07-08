// App shell: page content above a fixed bottom navigation bar (mobile-first;
// capped width keeps it sane on desktop).
import HomeIcon from '@mui/icons-material/Home';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import StorefrontIcon from '@mui/icons-material/Storefront';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import { Outlet, useLocation, useNavigate } from 'react-router';

const TABS = ['/', '/market', '/pay', '/activity', '/more'];

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const value = TABS.includes(pathname) ? pathname : false;

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', pb: 10 }}>
      <Outlet />
      <Paper
        elevation={3}
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: (theme) => theme.zIndex.appBar,
        }}
      >
        <BottomNavigation
          showLabels
          value={value}
          onChange={(_event, tab) => void navigate(tab as string)}
        >
          <BottomNavigationAction label="Home" value="/" icon={<HomeIcon />} />
          <BottomNavigationAction
            label="Market"
            value="/market"
            icon={<StorefrontIcon />}
          />
          <BottomNavigationAction
            label="Pay"
            value="/pay"
            icon={<QrCodeScannerIcon />}
          />
          <BottomNavigationAction
            label="Activity"
            value="/activity"
            icon={<ReceiptLongIcon />}
          />
          <BottomNavigationAction
            label="More"
            value="/more"
            icon={<MoreHorizIcon />}
          />
        </BottomNavigation>
      </Paper>
    </Box>
  );
}
