declare const chrome: {
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<Array<{ id?: number }>>;
    create(properties: { url: string }): Promise<unknown>;
  };
  scripting: {
    executeScript<T>(details: { target: { tabId: number }; func: () => T }): Promise<Array<{ result?: T }>>;
  };
};
