export interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  REPOSITORIES: DurableObjectNamespace;
  ASSETS: Fetcher;
  EVENTS?: Queue<{ id: string }>;
  WEBHOOK_ALLOWED_HOSTS?: string;
  APP_ORIGIN: string;
  BOOTSTRAP_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SYNC_ALLOWED_HOSTS?: string;
}
export interface User {
  id: string;
  username: string;
  admin: number;
}
export interface Repo {
  id: string;
  owner_id: string;
  namespace: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  created_at: string;
  deleted_at?: string | null;
  base_repo?: string | null;
  fork_source?: string | null;
  sync_status?: string;
  sync_error?: string | null;
  synced_at?: string | null;
}
export type App = {
  Bindings: Env;
  Variables: {
    user: User | null;
    repoRole: string;
    scope: "read" | "write";
    kind: "pat" | "session" | "jwt" | null;
    delegation?: import("./delegation").Delegation;
    credential: string | null;
  };
};
