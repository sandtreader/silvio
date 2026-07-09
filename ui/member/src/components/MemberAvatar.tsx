// Member avatar: profile photo when one is set (served at /i/{id},
// decision #14), initials fallback otherwise.
import Avatar from '@mui/material/Avatar';

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => (word[0] ?? '').toUpperCase())
    .join('');
}

export function MemberAvatar({
  name,
  photoId,
  size = 40,
}: {
  name: string;
  photoId?: string | undefined;
  size?: number;
}) {
  return (
    <Avatar
      src={photoId === undefined ? undefined : `/i/${photoId}`}
      alt={name}
      sx={{ width: size, height: size }}
    >
      {initials(name)}
    </Avatar>
  );
}
