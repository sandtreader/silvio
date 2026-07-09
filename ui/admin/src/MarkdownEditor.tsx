// Markdown body editor for the CMS screens (decision #13): a plain textarea
// with a live preview pane beside it (below on narrow screens). The preview
// runs src/markdown.ts — the same markdown-it configuration as the server —
// so what the admin sees is exactly what the brochure renders. Injecting the
// rendered HTML is safe because the renderer escapes raw HTML (html: false)
// and never emits <img> (image rule disabled).

import { Paper, Stack, TextField, Typography } from '@mui/material';
import { renderMarkdown } from './markdown';

export function MarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
      <TextField
        label="Body"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        multiline
        minRows={10}
        sx={{ flex: 1 }}
      />
      <Paper
        variant="outlined"
        sx={{ flex: 1, padding: 2, overflow: 'auto', minHeight: 0 }}
      >
        <Typography variant="caption" color="text.secondary">
          Preview
        </Typography>
        <div
          data-testid="markdown-preview"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
        />
      </Paper>
    </Stack>
  );
}
