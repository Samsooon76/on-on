declare const chrome: {
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  permissions: { request(options: { origins: string[] }): Promise<boolean> };
  tabs: {
    query(query: { active?: boolean; lastFocusedWindow?: boolean; url?: string }): Promise<Array<{ id?: number; url?: string }>>;
    update(id: number, properties: { active: boolean }): Promise<unknown>;
    create(properties: { url: string; active?: boolean }): Promise<{ id?: number }>;
  };
  scripting: {
    executeScript<T, A extends unknown[]>(details: { target: { tabId: number }; world?: "MAIN"; args?: A; func: (...args: A) => T }): Promise<Array<{ result?: T }>>;
  };
};
