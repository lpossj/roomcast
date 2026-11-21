import { initials } from './lib.js';
import { cleanAvatar, MAX_AVATAR_LENGTH } from '../server/avatar-policy.mjs';
import { imageDimensionsAllowed, readImageDimensions } from './image-policy.js';
import { compressAnimatedGif, fileBytesToGifDataUrl } from './lib/gifAvatar.js';

export function safeAvatar(value) {
  try { return cleanAvatar(value); } catch { return ''; }
}

let legacyAvatarSource = '', legacyAvatarTask = null;
export function prepareAvatarForRoom(value, animatedAvatars) {
  const avatar = cleanAvatar(value);
  if (!avatar || animatedAvatars || (avatar.length <= 32 * 1024 && !avatar.startsWith('data:image/gif;'))) {
    return Promise.resolve(avatar);
  }
  // Older hosts advertise profiles:1 too, but reject GIF and disconnect large RPCs.
  // Keep the user's original animation locally; only adapt the transmitted avatar.
  if (legacyAvatarTask && legacyAvatarSource === avatar) return legacyAvatarTask;
  legacyAvatarSource = avatar;
  legacyAvatarTask = (async () => {
    const image = new Image();
    image.src = avatar;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法生成兼容头像。');
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    context.fillStyle = '#202a32'; context.fillRect(0, 0, 128, 128);
    context.drawImage(image, (image.naturalWidth - edge) / 2, (image.naturalHeight - edge) / 2, edge, edge, 0, 0, 128, 128);
    for (const quality of [0.8, 0.6, 0.4]) {
      const result = canvas.toDataURL('image/jpeg', quality);
      if (result.length <= 32 * 1024) return cleanAvatar(result);
    }
    throw new Error('兼容头像超过旧房间的大小限制。');
  })();
  return legacyAvatarTask;
}

export default function Avatar({ member = {}, className = 'avatar', speaking = false, children, ...props }) {
  const image = safeAvatar(member.avatar);
  const color = Number.isInteger(member.avatarColor) && member.avatarColor >= 0 && member.avatarColor < 10 ? member.avatarColor : 0;
  return <span className={`${className} avatar-color-${color}${speaking ? ' is-speaking' : ''}`} {...props}>
    {image ? <img src={image} alt="" draggable={false} /> : initials(member.name || '访')}{children}
  </span>;
}

export async function prepareAvatar(file) {
  if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('请选择 10 MB 以内的 JPG、PNG、WebP 或 GIF 图片。');
  }
  if (file.type === 'image/gif') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dims = readImageDimensions('image/gif', bytes);
    if (!dims || !imageDimensionsAllowed(dims.width, dims.height)) {
      throw new Error('GIF 动图文件格式无效或尺寸超出限制。');
    }
    const rawDataUrl = fileBytesToGifDataUrl(bytes);
    if (rawDataUrl.length <= MAX_AVATAR_LENGTH) {
      return cleanAvatar(rawDataUrl);
    }
    return cleanAvatar(await compressAnimatedGif(bytes, MAX_AVATAR_LENGTH));
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
