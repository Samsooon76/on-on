export type QueryValue = string | number | boolean | null | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export type ApiPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type SmsSegmentInfo = {
  encoding: "GSM-7" | "Unicode";
  characterCount: number;
  segments: number;
  singleSegmentLimit: number;
  multipartSegmentLimit: number;
};

const gsm7Basic = new Set(Array.from(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
));
const gsm7Extended = new Set(Array.from("\f^{}\\[~]|€"));

/** Estimates SMS encoding and concatenated segment count using Twilio's documented limits. */
export function getSmsSegmentInfo(input: string): SmsSegmentInfo {
  let gsmSeptets = 0;
  let gsmCompatible = true;
  for (const character of input) {
    if (gsm7Basic.has(character)) gsmSeptets += 1;
    else if (gsm7Extended.has(character)) gsmSeptets += 2;
    else {
      gsmCompatible = false;
      break;
    }
  }

  const characterCount = input.length;
  if (!characterCount) {
    return { encoding: "GSM-7", characterCount: 0, segments: 0, singleSegmentLimit: 160, multipartSegmentLimit: 153 };
  }
  if (gsmCompatible) {
    return {
      encoding: "GSM-7",
      characterCount: gsmSeptets,
      segments: gsmSeptets <= 160 ? 1 : Math.ceil(gsmSeptets / 153),
      singleSegmentLimit: 160,
      multipartSegmentLimit: 153,
    };
  }

  return {
    encoding: "Unicode",
    characterCount,
    segments: characterCount <= 70 ? 1 : Math.ceil(characterCount / 67),
    singleSegmentLimit: 70,
    multipartSegmentLimit: 67,
  };
}

export type ApiClientOptions = {
  baseUrl: string;
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
  fetcher?: typeof fetch;
  createRequestId?: () => string;
};

export type ApiRequestOptions = RequestInit & {
  query?: Query;
  idempotencyKey?: string;
};

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(input: { message: string; status: number; code?: string; requestId?: string | null }) {
    super(input.message);
    this.name = "ApiClientError";
    this.status = input.status;
    this.code = input.code ?? "request_error";
    this.requestId = input.requestId ?? null;
  }
}

function requestId(): string {
  // This is a log correlation value, not an authentication or idempotency secret.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function encodeQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export function withQuery(path: string, query?: Query): string {
  const encoded = encodeQuery(query);
  if (!encoded) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${encoded}`;
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const makeRequestId = options.createRequestId ?? requestId;

  async function request<T>(path: string, init: ApiRequestOptions = {}): Promise<T> {
    const token = await options.getAccessToken();
    if (!token) throw new ApiClientError({ message: "Session expirée. Reconnectez-vous.", status: 401, code: "unauthorized" });

    const { query, idempotencyKey, ...requestInit } = init;
    const headers = new Headers(requestInit.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-request-id", makeRequestId());
    if (requestInit.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${withQuery(path, query)}`, { ...requestInit, headers });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new ApiClientError({ message: "L’API est momentanément inaccessible.", status: 0, code: "network_error" });
    }

    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody = body && typeof body === "object" ? body as Record<string, unknown> : {};
      throw new ApiClientError({
        message: typeof errorBody.message === "string" ? errorBody.message : "La requête a échoué.",
        status: response.status,
        code: typeof errorBody.code === "string" ? errorBody.code : "request_error",
        requestId: typeof errorBody.requestId === "string" ? errorBody.requestId : response.headers.get("x-request-id"),
      });
    }
    return body as T;
  }

  async function getPage<T>(path: string, input: { limit?: number; cursor?: string | null; query?: Query; signal?: AbortSignal } = {}): Promise<ApiPage<T>> {
    const result = await request<Partial<ApiPage<T>>>(path, {
      method: "GET",
      query: { ...input.query, limit: input.limit, cursor: input.cursor },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!Array.isArray(result.items) || !(result.nextCursor === null || typeof result.nextCursor === "string")) {
      throw new ApiClientError({ message: "La réponse paginée de l’API est invalide.", status: 502, code: "invalid_api_response" });
    }
    return result as ApiPage<T>;
  }

  return { request, getPage };
}

export const queryKeys = {
  organizations: (userId: string) => ["organizations", userId] as const,
  lines: (organizationId: string) => ["lines", organizationId] as const,
  contacts: (organizationId: string, search = "") => ["contacts", organizationId, search] as const,
  calls: (lineId: string, cursor: string | null = null) => ["calls", lineId, cursor] as const,
  conversations: (lineId: string, cursor: string | null = null) => ["conversations", lineId, cursor] as const,
  messages: (conversationId: string, cursor: string | null = null) => ["messages", conversationId, cursor] as const,
  devices: (userId: string, organizationId: string) => ["devices", userId, organizationId] as const,
};
