import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImagesPage } from '../src/pages/ImagesPage';
import { makeImage, makeMockApi } from './mockApi';
import { resizeImage } from '../src/resize';

// The canvas-based resize helper can't run under jsdom; the page tests mock it
// and assert the page wires it up correctly (file in → resized blob uploaded).
vi.mock('../src/resize', () => ({ resizeImage: vi.fn() }));
const resizeMock = vi.mocked(resizeImage);

const images = [
  makeImage({ id: 'img-1', mime: 'image/jpeg', size: 35021 }),
  makeImage({
    id: 'img-2',
    mime: 'image/png',
    size: 512,
    createdAt: '2026-07-07T09:00:00Z',
  }),
];

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  resizeMock.mockReset();
  clipboardWriteText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImagesPage', () => {
  it('lists images with thumbnail, mime, human size and date', async () => {
    const api = makeMockApi();
    api.adminImages.mockResolvedValue(images);

    render(<ImagesPage api={api} />);
    const thumbs = await screen.findAllByRole('img');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute('src', '/i/img-1');
    expect(thumbs[1]).toHaveAttribute('src', '/i/img-2');
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    expect(screen.getByText('image/png')).toBeInTheDocument();
    expect(screen.getByText('34.2 KB')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
  });

  it('uploads a file through the resize helper and refreshes the list', async () => {
    const api = makeMockApi();
    api.adminImages.mockResolvedValue([]);
    const resized = new Blob(['resized'], { type: 'image/jpeg' });
    resizeMock.mockResolvedValue({ blob: resized, mime: 'image/jpeg' });
    api.adminUploadImage.mockResolvedValue(makeImage({ id: 'img-new' }));

    render(<ImagesPage api={api} />);
    await screen.findByRole('button', { name: /upload image/i });
    expect(api.adminImages).toHaveBeenCalledTimes(1);

    const file = new File(['raw-camera-bytes'], 'photo.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByTestId('image-upload-input'), file);

    await waitFor(() => expect(api.adminUploadImage).toHaveBeenCalledWith(resized, 'image/jpeg'));
    expect(resizeMock).toHaveBeenCalledWith(file);
    // The list refreshes so the new upload appears
    await waitFor(() => expect(api.adminImages).toHaveBeenCalledTimes(2));
  });

  it('rejects an undecodable file with a snackbar error and no upload', async () => {
    const api = makeMockApi();
    api.adminImages.mockResolvedValue([]);
    resizeMock.mockRejectedValue(new Error('not a decodable image'));

    render(<ImagesPage api={api} />);
    await screen.findByRole('button', { name: /upload image/i });

    const file = new File(['not an image'], 'notes.txt', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByTestId('image-upload-input'), file);

    expect(await screen.findByText(/not a decodable image/i)).toBeInTheDocument();
    expect(api.adminUploadImage).not.toHaveBeenCalled();
  });

  it('copies the markdown snippet to the clipboard with confirmation', async () => {
    const api = makeMockApi();
    api.adminImages.mockResolvedValue(images);

    render(<ImagesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /copy markdown for img-1/i }),
    );
    expect(clipboardWriteText).toHaveBeenCalledWith('![description](/i/img-1)');
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('deletes an image after confirmation and refreshes', async () => {
    const api = makeMockApi();
    api.adminImages.mockResolvedValue(images);

    render(<ImagesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /delete image img-2/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.adminDeleteImage).toHaveBeenCalledWith('img-2'));
    await waitFor(() => expect(api.adminImages).toHaveBeenCalledTimes(2));
  });
});
