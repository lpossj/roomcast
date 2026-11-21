// Small, inline raster & animated GIF avatars can travel with room state without remote fetches.
export const MAX_AVATAR_LENGTH = 160 * 1024;
export function cleanAvatar(value = '') {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_AVATAR_LENGTH
    || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('头像须为压缩后的 JPG、PNG、WebP 或 GIF 动图（最多约 120 KB）。');
  }
  return value;
}
