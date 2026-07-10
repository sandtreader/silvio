// Site chrome (decision #15): the slim brochure-style header, rendered by
// the app itself because the service worker bypasses any server-side
// injection into index.html. Brand, nav and branding come from the public
// GET /shell endpoint; the session corner from the auth context, so it is
// always truthful about who is logged in. The links are plain full-page
// anchors — they leave the SPA for the server-rendered brochure — so the
// component takes no router dependency and mounts outside RouterProvider.
// Must stay visually in step with the brochure's own header
// (server/src/api/brochure.ts: SHELL_STYLE + shellHeader).
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import type { ShellInfo } from '@silvio/ui-shared';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';

const NAV_LINK = { color: '#205a3b' } as const;

export function SiteChrome() {
  const client = useClient();
  const { me } = useAuth();
  const [info, setInfo] = useState<ShellInfo | null>(null);

  // Fetched on mount and again when the member changes (login/logout):
  // members-visibility nav pages appear only for a recognised session (#13).
  const memberId = me?.member.id;
  useEffect(() => {
    let stale = false;
    client
      .shellInfo()
      .then((shell) => {
        if (!stale) setInfo(shell);
      })
      .catch(() => {
        // e.g. an unknown host: no chrome beats a wrong one.
        if (!stale) setInfo(null);
      });
    return () => {
      stale = true;
    };
  }, [client, memberId]);

  // While loading or after a failure the app renders chrome-less.
  if (info === null) return null;

  const { group, branding, navPages } = info;
  return (
    <>
    <Box
      component="header"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: 3,
        rowGap: 1,
        px: 2.5,
        py: 1.5,
        bgcolor: '#f6f6f2',
        color: '#1a1a1a',
        borderBottom: '1px solid #ddd',
        ...(branding.headerImageId !== undefined && {
          backgroundImage: `url('/i/${branding.headerImageId}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }),
        // Installed PWA: the app owns the whole window, no brochure framing
        // — the same media query hides the brochure's header (#12, #15).
        '@media (display-mode: standalone)': { display: 'none' },
      }}
    >
      <Link
        href="/"
        underline="none"
        sx={{ mr: 'auto', fontSize: '1.25rem', fontWeight: 700, color: 'inherit' }}
      >
        {branding.logoImageId !== undefined && (
          <Box
            component="img"
            src={`/i/${branding.logoImageId}`}
            alt=""
            sx={{ height: '1.5em', verticalAlign: 'middle', mr: 0.5 }}
          />
        )}
        {group.name}
      </Link>
      <Box component="nav" sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        <Link href="/" sx={NAV_LINK}>
          Home
        </Link>
        {navPages.map((page) => (
          <Link key={page.slug} href={`/p/${page.slug}`} sx={NAV_LINK}>
            {page.title}
          </Link>
        ))}
        <Link href="/news" sx={NAV_LINK}>
          News
        </Link>
        <Link href="/market" sx={NAV_LINK}>
          Market
        </Link>
        {me !== null && <Typography component="span">{me.member.displayName}</Typography>}
      </Box>
    </Box>
    {info.suspended === true && (
      // Suspension banner (#20): mirrors the brochure's amber notice.
      <Typography
        sx={{
          px: 2.5,
          py: 1,
          bgcolor: '#fff3cd',
          color: '#664d03',
          borderBottom: '1px solid #ffe69c',
        }}
      >
        This group is currently suspended — trading is paused.
      </Typography>
    )}
    </>
  );
}
