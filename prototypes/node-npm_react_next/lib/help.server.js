import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@/lib/log';

// SERVER-only: .mycl/help-pages.json'ı okur. MyCL bu dosyayı üretir; yoksa boş döner.
// Bu modülü ASLA bir client component'ten import etme (fs client bundle'a sızar).
export function getHelpPages() {
  try {
    const file = path.join(process.cwd(), '.mycl', 'help-pages.json');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn('help', 'help-pages.json okunamadı', { message: String(err) });
    return [];
  }
}
