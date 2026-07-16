import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrandingPage } from '../src/pages/BrandingPage';
import { makeImage, makeMockApi } from './mockApi';
import { resizeImage } from '../src/resize';

// The canvas-based resize helper can't run under jsdom; the page tests mock it
// and assert the page wires it up correctly (file in → resized blob uploaded).
vi.mock('../src/resize', () => ({ resizeImage: vi.fn() }));
const resizeMock = vi.mocked(resizeImage);

const logo = makeImage({ id: 'img-logo', ownerKind: 'brand', ownerId: 'logo' });

beforeEach(() => {
  resizeMock.mockReset();
});

describe('BrandingPage', () => {
  it('shows a filled logo slot and an empty header slot', async () => {
    const api = makeMockApi();
    api.adminBrandImages.mockResolvedValue([logo]);

    render(<BrandingPage api={api} />);
    expect(await screen.findByRole('img', { name: /logo/i })).toHaveAttribute(
      'src',
      '/i/img-logo',
    );
    expect(screen.getByText('Header background image')).toBeInTheDocument();
    expect(screen.getByText(/no image/i)).toBeInTheDocument();
    // A filled slot offers Replace and Remove; an empty one only Upload.
    // Accessible names carry the slot; visible text stays one word so the
    // buttons never wrap.
    expect(screen.getByRole('button', { name: /replace logo/i })).toHaveTextContent(
      /^Replace$/,
    );
    expect(screen.getByRole('button', { name: /remove logo/i })).toHaveTextContent(
      /^Remove$/,
    );
    expect(
      screen.getByRole('button', { name: /upload header background image/i }),
    ).toHaveTextContent(/^Upload$/);
    expect(
      screen.queryByRole('button', { name: /remove header/i }),
    ).not.toBeInTheDocument();
  });

  it('uploads the logo through the resize helper at the logo edge cap', async () => {
    const api = makeMockApi();
    api.adminBrandImages.mockResolvedValue([]);
    const resized = new Blob(['resized'], { type: 'image/jpeg' });
    resizeMock.mockResolvedValue({ blob: resized, mime: 'image/jpeg' });
    api.setBrandImage.mockResolvedValue(logo);

    render(<BrandingPage api={api} />);
    await screen.findByRole('button', { name: /upload logo/i });
    expect(api.adminBrandImages).toHaveBeenCalledTimes(1);

    const file = new File(['raw-camera-bytes'], 'logo.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('brand-upload-logo'), file);

    await waitFor(() =>
      expect(api.setBrandImage).toHaveBeenCalledWith('logo', resized, 'image/jpeg'),
    );
    expect(resizeMock).toHaveBeenCalledWith(file, 512);
    // The slot refreshes so the new image appears
    await waitFor(() => expect(api.adminBrandImages).toHaveBeenCalledTimes(2));
  });

  it('uploads the header at the wider header edge cap', async () => {
    const api = makeMockApi();
    api.adminBrandImages.mockResolvedValue([]);
    const resized = new Blob(['resized'], { type: 'image/jpeg' });
    resizeMock.mockResolvedValue({ blob: resized, mime: 'image/jpeg' });
    api.setBrandImage.mockResolvedValue(
      makeImage({ id: 'img-header', ownerKind: 'brand', ownerId: 'header' }),
    );

    render(<BrandingPage api={api} />);
    await screen.findByRole('button', { name: /upload header background image/i });

    const file = new File(['raw-camera-bytes'], 'banner.jpg', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByTestId('brand-upload-header'), file);

    await waitFor(() =>
      expect(api.setBrandImage).toHaveBeenCalledWith('header', resized, 'image/jpeg'),
    );
    expect(resizeMock).toHaveBeenCalledWith(file, 1600);
  });

  it('rejects an undecodable file with a snackbar error and no upload', async () => {
    const api = makeMockApi();
    api.adminBrandImages.mockResolvedValue([]);
    resizeMock.mockRejectedValue(new Error('not a decodable image'));

    render(<BrandingPage api={api} />);
    await screen.findByRole('button', { name: /upload logo/i });

    const file = new File(['not an image'], 'notes.txt', { type: 'image/jpeg' });
    await userEvent.upload(screen.getByTestId('brand-upload-logo'), file);

    expect(await screen.findByText(/not a decodable image/i)).toBeInTheDocument();
    expect(api.setBrandImage).not.toHaveBeenCalled();
  });

  it('removes a slot after confirmation and refreshes', async () => {
    const api = makeMockApi();
    api.adminBrandImages.mockResolvedValue([logo]);

    render(<BrandingPage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /remove logo/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(api.deleteBrandImage).toHaveBeenCalledWith('logo'));
    await waitFor(() => expect(api.adminBrandImages).toHaveBeenCalledTimes(2));
  });
});
