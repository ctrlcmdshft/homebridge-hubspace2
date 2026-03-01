import fs from 'fs';
import path from 'path';
import type { AuthState } from './types';

const FILE_NAME = 'hubspace-tokens.json';

export class TokenStore {
  private readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, FILE_NAME);
  }

  load(): AuthState | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as AuthState;
      if (data.accessToken && data.refreshToken && data.expiresAt) {
        return data;
      }
    } catch {
      // file missing or corrupt — fresh login needed
    }
    return null;
  }

  save(state: AuthState): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      // non-fatal — worst case the user re-authenticates on next restart
    }
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }
}
