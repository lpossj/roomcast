import { initials } from './lib.js';
import { cleanAvatar } from '../server/avatar-policy.mjs';

export function safeAvatar(value) {
  try { return cleanAvatar(value); } catch { return ''; }
}

export default function Avatar({ member = {}, className = 'avatar', speaking = false, children, ...props }) {
  const image = safeAvatar(member.avatar);
  const color = Number.isInteger(member.avatarColor) && member.avatarColor >= 0 && member.avatarColor < 10 ? member.avatarColor : 0;
  return <span className={`${className} avatar-color-${color}${speaking ? ' is-speaking' : ''}`} {...props}>
    {image ? <img src={image} alt="" draggable={false} /> : initials(member.name || '访')}{children}
  </span>;
}

export async function prepareAvatar(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('请选择 10 MB 以内的 JPG、PNG 或 WebP 图片。');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    const edge = Math.min(bitmap.width, bitmap.height);
    context.fillStyle = '#202a32'; context.fillRect(0, 0, 128, 128);
    context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 128, 128);
    return cleanAvatar(canvas.toDataURL('image/jpeg', 0.8));
  } finally { bitmap.close(); }
}
