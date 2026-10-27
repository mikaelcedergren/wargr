import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { isCxThemeMode, type CxThemeMode } from '@mikaelcedergren/cx-framework';

/** Wargr's independent reader and writing-room preferences; the app owns root theme classes. */
@Injectable({ providedIn: 'root' })
export class Appearance {
  private readonly document = inject(DOCUMENT);
  private readonly readerValue = signal<'light' | 'night'>(
    this.read('wg-theme') === 'night' ? 'night' : 'light',
  );
  private readonly adminValue = signal<CxThemeMode>(this.readAdmin());
  public readonly reader = this.readerValue.asReadonly();
  public readonly admin = this.adminValue.asReadonly();

  public toggleReader(): void {
    const next = this.reader() === 'night' ? 'light' : 'night';
    this.readerValue.set(next);
    this.write('wg-theme', next);
  }

  public selectAdmin(theme: CxThemeMode): void {
    this.adminValue.set(theme);
    this.write('wg-admin-theme', theme);
  }

  private readAdmin(): CxThemeMode {
    const saved = this.read('wg-admin-theme');
    return isCxThemeMode(saved) ? saved : 'night';
  }

  private read(key: string): string | null {
    try {
      return this.document.defaultView?.localStorage.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.document.defaultView?.localStorage.setItem(key, value);
    } catch {
      // Storage may be blocked; the current session still keeps its selection.
    }
  }
}
