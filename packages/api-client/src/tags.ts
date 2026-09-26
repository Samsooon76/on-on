import { tagCatalogSchema, tagSubjectSchema, type TagInput, type TagKind, type TagSettingsInput, type TagSubject } from "@onoff/contracts";
export type TagApi = <T>(path: string, options?: RequestInit) => Promise<T>;
export function createTagClient(api: TagApi) {
  const path = (kind: TagKind, id: string) => `/v1/tagging/${kind}/${encodeURIComponent(id)}`;
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
  return {
    async catalog(org: string, signal?: AbortSignal) { return tagCatalogSchema.parse(await api(`/v1/organizations/${encodeURIComponent(org)}/tags`, signal ? { signal } : {})); },
    save(org: string, input: TagInput, id?: string) { return api(id ? `/v1/tags/${encodeURIComponent(id)}` : `/v1/organizations/${encodeURIComponent(org)}/tags`, json(id ? "PUT" : "POST", input)); },
    remove(id: string) { return api(`/v1/tags/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    settings(org: string, input: TagSettingsInput) { return api(`/v1/organizations/${encodeURIComponent(org)}/tag-settings`, json("PUT", input)); },
    async subject(kind: TagKind, id: string, signal?: AbortSignal) { return tagSubjectSchema.parse(await api(path(kind, id), signal ? { signal } : {})); },
    async assign(kind: TagKind, id: string, tagId: string, assigned: boolean) { return tagSubjectSchema.parse(await api(`${path(kind, id)}/tags/${encodeURIComponent(tagId)}`, json("PUT", { assigned }))); },
    async classify(kind: TagKind, id: string) { return tagSubjectSchema.parse(await api(`${path(kind, id)}/classify`, { method: "POST" })); },
  };
}
export const tagStatus: Record<TagSubject["status"], string> = { idle: "Pas encore analysé", pending: "Analyse en attente", processing: "Analyse en cours…", completed: "Analyse terminée", skipped: "Analyse non appliquée", error: "Échec de l’analyse" };
export { tagInputSchema } from "@onoff/contracts";
export type { Tag, TagCatalog, TagInput, TagKind, TagSubject } from "@onoff/contracts";
