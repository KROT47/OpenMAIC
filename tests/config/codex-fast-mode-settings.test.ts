import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const persistKv = new BrowserKVStore({ storage: localStorageStub as unknown as Storage });

async function freshStore(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  storage.clear();
  if (persistedState) {
    await persistKv.set('settings-storage', { state: persistedState, version: 4 }, 'account');
  }
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

async function readPersistedState(): Promise<Record<string, unknown>> {
  return await vi.waitFor(async () => {
    const blob = await persistKv.get<{ state: Record<string, unknown> }>(
      'settings-storage',
      'account',
    );
    expect(blob).not.toBeNull();
    return blob!.state;
  });
}

describe('Codex fast mode preference', () => {
  beforeEach(() => storage.clear());

  it('defaults to off', async () => {
    const store = await freshStore();

    expect(store.getState().codexFastMode).toBe(false);
  });

  it('persists the user selection', async () => {
    const store = await freshStore();

    store.getState().setCodexFastMode(true);

    expect(store.getState().codexFastMode).toBe(true);
    expect((await readPersistedState()).codexFastMode).toBe(true);
  });

  it('hydrates an older settings blob with the default off', async () => {
    const store = await freshStore({ ttsSpeed: 1.25 });

    expect(store.getState().codexFastMode).toBe(false);
  });
});
