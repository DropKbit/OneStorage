export interface Env {
  DB: D1Database;
  LOADER?: WorkerLoader;
  BUILDER?: Fetcher;
  APPS_ORIGIN?: string;
  OBJECTS: R2Bucket;
  REPOSITORIES: DurableObjectNamespace;
  ASSETS: Fetcher;
  EVENTS?: Queue<{ id: string }>;
  WEBHOOK_ALLOWED_HOSTS?: string;
  APP_ORIGIN: string;
  BOOTSTRAP_SECRET: string;
  LEGACY_APP_ORIGIN?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SYNC_ALLOWED_HOSTS?: string;
  CI_ALLOWED_HOSTS?: string;
}
export interface User {
  id: string;
  username: string;
  admin: number;
}
export interface Repo {
  id: string;
  owner_id: string;
  workspace_id?: string | null;
  namespace: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  created_at: string;
  deleted_at?: string | null;
  archived_at?: string | null;
  lifecycle_revision?: number;
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
    kind: "pat" | "session" | "jwt" | "deploy" | null;
    deploy?: import("./deploy-tokens").DeployToken;
    delegation?: import("./delegation").Delegation;
    credential: string | null;
  };
};
