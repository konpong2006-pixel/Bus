import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..');

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index <= 0) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadDotEnv();

const token = process.env.RICH_MENU_CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
const defaultLiffId = '2011067844-ev4LeC1D';
const liffId = String(process.env.LIFF_ID || process.env.DEFAULT_LIFF_ID || defaultLiffId).trim();
const liffUrl = liffId ? `https://liff.line.me/${liffId}` : '';
const baseUrl = liffUrl
  || process.env.RICH_MENU_LINK_URL
  || '';
const imagePath = process.env.RICH_MENU_IMAGE_PATH
  ? path.resolve(process.env.RICH_MENU_IMAGE_PATH)
  : path.join(root, 'public', 'rich-menu', 'booking.png');
const name = process.env.RICH_MENU_NAME || 'Bus booking rich menu';
const chatBarText = process.env.RICH_MENU_CHAT_BAR_TEXT || 'เมนูจองตั๋ว';
const deleteExisting = !['false', '0', 'no'].includes(String(process.env.RICH_MENU_DELETE_EXISTING ?? 'true').toLowerCase());

function requireValue(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

async function lineApi(pathname, options = {}) {
  const response = await fetch(`https://api.line.me${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${requireValue(token, 'LINE channel access token')}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function uploadRichMenuImage(richMenuId) {
  const image = fs.readFileSync(imagePath);
  const contentType = ['.jpg', '.jpeg'].includes(path.extname(imagePath).toLowerCase())
    ? 'image/jpeg'
    : 'image/png';

  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireValue(token, 'LINE channel access token')}`,
      'Content-Type': contentType
    },
    body: image
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Upload rich menu image failed: ${response.status} ${text}`);
}

async function main() {
  requireValue(baseUrl, 'LIFF_ID or RICH_MENU_LINK_URL');
  if (!fs.existsSync(imagePath)) throw new Error(`Rich menu image not found: ${imagePath}`);

  if (deleteExisting) {
    const list = await lineApi('/v2/bot/richmenu/list');
    for (const item of list.richmenus || []) {
      if (item.name === name) {
        await lineApi(`/v2/bot/richmenu/${item.richMenuId}`, { method: 'DELETE' });
        console.log(`Deleted existing rich menu: ${item.richMenuId}`);
      }
    }
  }

  const richMenu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name,
    chatBarText,
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1650, height: 843 },
        action: {
          type: 'uri',
          label: 'จองตั๋ว',
          uri: baseUrl
        }
      },
      {
        bounds: { x: 1650, y: 0, width: 850, height: 421 },
        action: {
          type: 'message',
          label: 'เช็กรอบรถ',
          text: 'เช็กรอบรถ'
        }
      },
      {
        bounds: { x: 1650, y: 421, width: 850, height: 422 },
        action: {
          type: 'message',
          label: 'ติดต่อแอดมิน',
          text: 'ติดต่อแอดมิน'
        }
      }
    ]
  };

  const created = await lineApi('/v2/bot/richmenu', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(richMenu)
  });
  await uploadRichMenuImage(created.richMenuId);
  await lineApi(`/v2/bot/user/all/richmenu/${created.richMenuId}`, { method: 'POST' });

  console.log('Rich menu is ready');
  console.log(`richMenuId=${created.richMenuId}`);
  console.log(`url=${baseUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
