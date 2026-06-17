import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function safeName(value, fallback) {
  const text = String(value || fallback || 'image')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return text || fallback || 'image';
}

function safeTaskId(taskId) {
  return String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
  };
}

export async function saveTaskAttachments(root, taskId, attachments = []) {
  const accepted = [];
  const rejected = [];
  const items = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  const taskRoot = path.join(root, safeTaskId(taskId));
  await mkdir(taskRoot, { recursive: true });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;

    const parsed = parseDataUrl(item.data_url);
    if (!parsed) {
      rejected.push({
        order: index + 1,
        name: String(item.name || `image-${index + 1}`),
        reason: 'unsupported_or_invalid_image',
      });
      continue;
    }

    if (parsed.bytes.length > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        order: index + 1,
        name: String(item.name || `image-${index + 1}`),
        reason: 'image_too_large',
      });
      continue;
    }

    const extension = MIME_EXTENSIONS[parsed.mimeType] || 'img';
    const baseName = safeName(item.name, `image-${index + 1}`).replace(/\.[a-z0-9]+$/i, '');
    const fileName = `${String(index + 1).padStart(2, '0')}-${baseName}.${extension}`;
    const filePath = path.join(taskRoot, fileName);
    await writeFile(filePath, parsed.bytes);

    accepted.push({
      id: String(item.id || `${taskId}-${index + 1}`),
      order: index + 1,
      name: String(item.name || fileName),
      source: String(item.source || 'user-upload'),
      mime_type: parsed.mimeType,
      size: parsed.bytes.length,
      path: filePath,
    });
  }

  return { accepted, rejected };
}
