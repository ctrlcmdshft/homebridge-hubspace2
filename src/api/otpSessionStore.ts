import fs from 'fs';
import path from 'path';

export interface OtpSession {
  sessionCode: string;
  execution: string;
  tabId: string;
  pkceVerifier: string;
  createdAt: number; // ms epoch
}

const FILE_NAME = 'hubspace-otp-session.json';
/** Sessions older than 10 minutes are considered expired */
const MAX_AGE_MS = 10 * 60 * 1000;

export class OtpSessionStore {
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, FILE_NAME);
  }

  save(session: OtpSession): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(session, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  load(): OtpSession | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as OtpSession;
      if (Date.now() - data.createdAt > MAX_AGE_MS) {
        this.clear();
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  clear(): void {
    try { fs.unlinkSync(this.filePath); } catch { /* ignore */ }
  }
}
